import { beforeAll, describe, expect, it } from "vitest";
import { messageBodies } from "@trafficflow/db";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { partReadingOf, partWordsOf } from "@trafficflow/db/dialect";
import { SearchService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

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
    await db.insert(messageBodies).values({ messageId: id, text: body });
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

describe.each([
  ["with the search documents built", true],
  ["before the documents are built (the rows' own columns)", false],
])("a part of a word finds what the whole word finds — %s", (_label, built) => {
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
 * THE START OF A PUNCTUATED TOKEN FINDS WHAT THE WHOLE TOKEN FINDS, on both stores and the desktop's
 * own: the server's parser keeps an address, a host, a path, a decimal, a version or a URL as one
 * word, while the arm asked each run apart, a short last run as a whole word. Watched red at the
 * base: every start below found nothing, and a query of more than eight words opened no part.
 */
const TOKENS: ReadonlyArray<readonly [key: string, body: string, whole: string, starts: readonly string[]]> = [
  ["addr", "Write to desk@site.example today.", "desk@site.example", ["desk@site.exa", "desk@site.e", "desk@si"]],
  ["dec", "The ratio is 3.14159 here.", "3.14159", ["3.141", "3.14"]],
  ["path", "See docs/setup for details.", "docs/setup", ["docs/set"]],
  ["host", "The server mail.example.org is down.", "mail.example.org", ["mail.exa"]],
  ["ip", "Ping 10.0.0.1 again.", "10.0.0.1", ["10.0.0"]],
  ["ver", "Running v1.2.3 now.", "v1.2.3", ["v1.2"]],
  ["under", "Reply to first_last@site.example soon.", "first_last@site.example", ["first_last@si"]],
  ["url", "Read example.com/path/to/page first.", "example.com/path/to/page", ["example.com/pa", "example.com/path"]],
  ["file", "Saved as report.final.pdf yesterday.", "report.final.pdf", ["report.fin"]],
  ["js", "Upgrade node.js first.", "node.js", ["node.j"]],
  ["ledger", "The harbour_ledger is attached.", "harbour_ledger", ["harbour_ledg"]],
];
/**
 * A whole hyphenated or underscore word with no run of four letters, beside a start: Postgres keeps
 * `add-ons` as `add-on` and splits `api_ids` into `api` and `id`, which the piece's own runs never asked.
 */
const BESIDE: ReadonlyArray<readonly [key: string, body: string, typed: readonly string[]]> = [
  ["addons", "Your plan includes three add-ons for the quarterly invoice.", ["add-ons invoi", "invoi add-ons", "add-ons quarte"]],
  ["popups", "Block the pop-ups in Chrome.", ["pop-ups chro", "chro pop-ups"]],
  ["todos", "Your to-dos for tomorrow are listed.", ["to-dos tomor"]],
  ["apiids", "The api_ids column is indexed.", ["api_ids colu"]],
];
const LONG_BODY = "Minutes: harbour board meeting, ledger review, every captain present, desk@site.example, elevation notes.";

async function punctuated(built: boolean) {
  const { db, ctx, accountId, mailboxId } = await makeCtx();
  const keyOf = new Map<string, string>();
  const put = async (key: string, body: string, i: number) => {
    const id = await seedMessage(db, accountId, mailboxId, {
      subject: `Weekly note ${i}`, from: `sender${i}@mail.test`, snippet: "See below.", folder: "INBOX",
      date: new Date(Date.parse("2026-07-20T09:00:00Z") - i * 86_400_000),
    });
    await db.insert(messageBodies).values({ messageId: id, text: body });
    keyOf.set(id, key);
  };
  const rows: Array<readonly [string, string]> = [
    ...TOKENS.map(([key, body]) => [key, body] as const), ...BESIDE.map(([key, body]) => [key, body] as const),
    ["apart", "The desk at the site, for example, is free."], ["digits", "Seats 3 and 14 are free; rows 10 and 0, gates v1 and 2."],
    ["long", LONG_BODY], ["decoy", "See you soon."],
  ];
  for (const [i, [key, body]] of rows.entries()) await put(key, body, i + 1);
  if (built) expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
  return { ctx, keyOf };
}

describe.each([
  ["the store, documents built", true, false],
  ["the store, before the documents are built", false, false],
  ["the desktop's own store", true, true],
])("the start of a punctuated token — %s", (_label, built, localStore) => {
  const svc = localStore ? new SearchService({ indexFills: true, localStore: true }) : new SearchService();
  let answer: (q: string) => Promise<{ tier: string; keys: Set<string> }>;
  beforeAll(async () => {
    const { ctx, keyOf } = await punctuated(built);
    answer = async (q) => {
      const r = await svc.search(ctx, { q, limit: 50 });
      return { tier: r.tier, keys: new Set(r.items.map((m) => keyOf.get(m.id)!)) };
    };
  }, 60_000);

  it("(6) every start of four characters or more finds every letter the whole token finds by holding it", async () => {
    const wrong: unknown[] = [];
    for (const [key, , whole, starts] of TOKENS) {
      const w = await answer(whole);
      // The control: the whole token finds its letter. Letters holding its words apart are the runs' reach, not the token's.
      expect({ whole, tier: w.tier, found: w.keys.has(key) }).toEqual({ whole, tier: "exact", found: true });
      const holders = [...w.keys].filter((k) => (k === "long" ? LONG_BODY : TOKENS.find((t) => t[0] === k)?.[1] ?? "").includes(whole));
      for (const s of starts) {
        const p = await answer(s);
        const missing = holders.filter((k) => !p.keys.has(k));
        if (p.tier !== "exact" || missing.length > 0) wrong.push({ s, tier: p.tier, missing });
      }
    }
    expect(wrong).toEqual([]);
  });

  it("(7) no start answers a decoy: digits apart, an unrelated letter", async () => {
    for (const s of ["3.14", "3.141", "10.0.0", "v1.2", "desk@site.e", "docs/set", "node.j"]) {
      const p = await answer(s);
      expect({ s, extra: [...p.keys].filter((k) => k === "digits" || k === "decoy") }).toEqual({ s, extra: [] });
    }
  });

  it("(8) a piece under four characters is not read as a start: `3.1`; on Postgres nor `harbour_l`", async () => {
    expect(partWordsOf("3.1")).toBeNull();
    const p = await answer("3.1");
    expect(p.tier === "exact" && p.keys.has("dec")).toBe(false);
    // On Postgres neither is a last run under four after `_`: `l:*` would read every account's index. The phone's own store may.
    if (process.env.OHMAIL_TEST_DIALECT === "sqlite") return;
    const u = await answer("harbour_l");
    expect(u.tier === "exact" && u.keys.has("ledger")).toBe(false);
  });

  it("(9) past eight words the last one is still read as a start; a fragment before it is read whole", async () => {
    for (const q of ["harbour board meeting ledger review every captain present elevat",
      "harbour board desk@site.example meeting ledger review every captain present elevat"]) {
      const p = await answer(q);
      expect({ q, tier: p.tier, found: p.keys.has("long") }).toEqual({ q, tier: "exact", found: true });
    }
    const early = await answer("harbou board meeting ledger review every captain present elevation");
    expect(early.tier === "exact" && early.keys.has("long")).toBe(false);
  });

  it("(10) a whole hyphenated or underscore word beside a start finds its letter", async () => {
    const wrong: unknown[] = [];
    for (const [key, , typed] of BESIDE) {
      for (const q of typed) {
        const p = await answer(q);
        if (p.tier !== "exact" || !p.keys.has(key)) wrong.push({ q, tier: p.tier });
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("the part arm's reading of a punctuated query", () => {
  it("(4) inlines a piece of letters, digits and single joining marks only, whatever was typed", () => {
    const PIECE = /^[\p{L}\p{N}]+(?:[-./@_][\p{L}\p{N}]+)+$/u;
    const typed = ["desk@site.exa", "a'b.c@d", "x..y/z", "'; drop table--x.y", "o'brien.co\\uk", "3.14+5_6", "über.straße/weg", "a@@b._c"];
    const pieces = typed.flatMap((q) => partReadingOf(q)?.units.flatMap((u) => (u.joined === null ? [] : [u.joined])) ?? []);
    expect(pieces.length).toBeGreaterThan(4);
    expect(pieces.filter((p) => !PIECE.test(p))).toEqual([]);
    expect(partReadingOf("desk@site.exa")!.units).toEqual([{ at: [0, 1, 2], joined: "desk@site.exa", start: true }]);
    expect(partReadingOf("3.14")!.units[0]!.start).toBe(true);
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
      await db.insert(messageBodies).values({ messageId: id, text: body });
      ids[key] = id;
    };
    await put("obrien", "Letter from O'Brien", "Regards.");
    await put("email", "Your e-mail address", "Confirm it.");
    await put("portal", "Portal access", "Granted.");
    await put("colon", "Minutes: budget", "Attached.");
    await put("axa", "axa claim", "Filed.");
    await put("axalta", "Axalta coating", "Quote.");
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
