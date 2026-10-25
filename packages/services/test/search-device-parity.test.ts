import { beforeAll, describe, expect, it } from "vitest";
import { attachments, messageBodies } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchIndex, type EngineMessage } from "@ohmail/client-engine";
import { SearchService, type SearchSort } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * THE DEVICE FINDS WHAT THE SERVER FINDS. This file runs in the default project (Postgres, as
 * PGlite, whose english stemmer is the server's) and in the sqlite project (the phone's store), and
 * TABLE is what Postgres answers in the exact tier: (1) every store answers the table, and (2) the
 * mirror index, the first paint on every client, answers a SUBSET of it, so no row appears and then
 * vanishes when the store answers. Bounded, named differences: STEMMER (Porter on the device,
 * Snowball on the server), PREFIX (FTS5 stems a part's prefix too), SHORT (the mirror's type-ahead
 * under four letters).
 */
const CORPUS: ReadonlyArray<readonly [key: string, subject: string, body: string]> = [
  ["duns", "Your D-U-N-S Number is enclosed", "Keep it safe."], ["email", "Your e-mail address", "Confirm it."],
  ["reenter", "Code", "Please re-enter the code below."], ["coop", "Agenda", "We co-operate with the county."],
  ["delivery", "Delivery window", "Between nine and noon."], ["delivered", "Parcel", "Your parcel was delivered today."],
  ["deliveries", "Weekly", "Two deliveries are late."], ["running", "Status", "The job is running now."],
  ["runs", "Timetable", "The bus runs hourly."], ["invoices", "Accounts", "Three invoices attached."],
  ["invoice", "Your invoice", "Thanks."], ["organizing", "Weekend", "We are organizing the files."],
  ["organization", "Board", "The organization met."], ["connection", "Network", "The connection dropped."],
  ["connected", "Router", "Everything connected again."], ["elevation", "Trip", "The elevation gain was large."],
  ["myaxa", "Welcome to myAXA", "Sign in."], ["unbelievable", "Wow", "An unbelievable result."],
  ["quarterly", "Figures", "The quarterly figures are in."], ["awe", "Notes", "A sense of awe."],
  ["awful", "Diary", "An awful day."], ["awfully", "Queue", "An awfully long wait."], ["decoy", "Holiday plans", "See you soon."],
];

/** Query → the keys Postgres answers in the exact tier; `[]` is a closest-words answer or none. */
const TABLE: ReadonlyArray<readonly [q: string, keys: readonly string[]]> = [
  // joined forms: a compound is found as written and by its parts, never by the parts run together
  ["DUNS", []], ["D-U-N-S", ["duns"]], ["email", []], ["e-mail", ["email"]], ["reenter", []], ["re-enter", ["reenter"]],
  ["cooperate", []], ["co-operate", ["coop"]],
  // stems
  ["delivered", ["delivered"]], ["delivery", ["deliveries", "delivery"]], ["deliveries", ["deliveries", "delivery"]],
  ["deliver", ["delivered", "deliveries", "delivery"]], ["run", ["running", "runs"]], ["running", ["running", "runs"]],
  ["runs", ["running", "runs"]], ["invoices", ["invoice", "invoices"]], ["invoice", ["invoice", "invoices"]],
  ["organize", ["organization", "organizing"]], ["organizing", ["organization", "organizing"]],
  ["organization", ["organization", "organizing"]], ["connect", ["connected", "connection"]],
  ["connected", ["connected", "connection"]], ["connection", ["connected", "connection"]],
  ["awe", ["awe"]], ["awfully", ["awful", "awfully"]],
  // part-words from the start, from four letters
  ["elevat", ["elevation"]], ["unbeliev", ["unbelievable"]], ["quarter", ["quarterly"]],
  ["deliv", ["delivered", "deliveries", "delivery"]], ["organiz", ["organization", "organizing"]],
  // a part inside a word: found in the headers, not in the text
  ["levation", []], ["believ", []], ["arterly", []], ["AXA", ["myaxa"]], ["voice", ["invoice"]],
  // under four letters
  ["inv", ["invoice"]], ["del", ["delivery"]], ["co", ["coop"]], ["qua", []], ["ele", []],
];

/**
 * STEMMER: where the device's Porter and the server's Snowball part, one pair each way (a small
 * share of stems over a long word list). Asked by the whole word, since a part-word prefix reaches past a stem.
 */
const STEMMER: Readonly<Record<string, { device: readonly string[] }>> = {
  awfully: { device: ["awfully"] },      // the server alone reaches `awful`
  awe: { device: ["awe", "awful"] },     // the device alone reaches `awful`
};
/**
 * PREFIX: FTS5's porter stems a part-word's prefix as well, so the device's `"delivered"*` reads
 * as `deliv*` and reaches `delivery` where the server's `'delivered':*` reaches nothing
 * (DEVICE-PART-PREFIX-IS-STEMMED). There the device answers MORE than the table, never less.
 */
const PREFIX: Readonly<Record<string, readonly string[]>> = { delivered: ["delivered", "deliveries", "delivery"] };
/** SHORT: under four letters the mirror is a type-ahead, so it answers at least the table. */
const SHORT = new Set(["inv", "del", "co", "qua", "ele"]);

function engineMessage(id: string, subject: string, body: string, i: number): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, to: [], cc: [], folder: "INBOX",
    unread: false, hasAttachments: false, attachmentCount: 0, triage: null, labels: [], remoteContent: "none",
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    updatedAt: "2026-09-08T12:00:00.000Z", id, subject, from: { name: null, address: `s${i}@site.example` },
    snippet: body, date: new Date(Date.parse("2026-07-20T09:00:00Z") - i * 86_400_000).toISOString(),
  };
}

describe("the device answers what the server answers", () => {
  let store: (q: string) => Promise<string[]>;
  let mirror: (q: string) => string[];
  let device = false;
  beforeAll(async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    device = dialect(db).name === "sqlite";
    const keyOf = new Map<string, string>();
    const index = new SearchIndex();
    for (const [i, [key, subject, body]] of CORPUS.entries()) {
      const id = await seedMessage(db, accountId, mailboxId, {
        subject, from: `s${i}@site.example`, snippet: body, folder: "INBOX",
        date: new Date(Date.parse("2026-07-20T09:00:00Z") - i * 86_400_000),
      });
      await db.insert(messageBodies).values({ messageId: id, text: body });
      keyOf.set(id, key);
      index.add(engineMessage(id, subject, body, i));
    }
    expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
    store = async (q) => {
      const r = await new SearchService().search(ctx, { q, limit: 50 });
      return r.tier === "exact" ? r.items.map((m) => keyOf.get(m.id)!).sort() : [];
    };
    mirror = (q) => index.search(q, { limit: 50 }).items.map((h) => keyOf.get(h.message.id)!).sort();
  }, 60_000);

  it(`rule 1: the store answers the table (${TABLE.length} queries), the STEMMER and PREFIX classes apart on the device`, async () => {
    const wrong: Array<{ q: string; got: string[]; want: readonly string[] }> = [];
    for (const [q, keys] of TABLE) {
      if (device && PREFIX[q]) expect(keys.every((k) => PREFIX[q]!.includes(k)), `${q}: PREFIX only ever adds`).toBe(true);
      const want = device && STEMMER[q] ? STEMMER[q]!.device : device && PREFIX[q] ? PREFIX[q]! : keys;
      const got = await store(q);
      if (got.join() !== [...want].sort().join()) wrong.push({ q, got, want });
    }
    expect(wrong).toEqual([]);
  });

  it("rule 2: from four letters the mirror answers a subset of the table; under four, at least the table", () => {
    const wrong: Array<{ q: string; mirror: string[]; table: readonly string[] }> = [];
    for (const [q, keys] of TABLE) {
      const got = mirror(q);
      const ok = SHORT.has(q) ? keys.every((k) => got.includes(k)) : got.every((k) => keys.includes(k));
      if (!ok) wrong.push({ q, mirror: got, table: keys });
    }
    expect(wrong).toEqual([]);
  });

  it("the STEMMER class: each store's own pair, in its own direction", async () => {
    expect(await store("awfully"), device ? "Porter keeps awful apart" : "Snowball joins awful").toEqual(device ? ["awfully"] : ["awful", "awfully"]);
    expect(await store("awe"), device ? "Porter joins awful" : "Snowball keeps awful apart").toEqual(device ? ["awe", "awful"] : ["awe"]);
  });
});

/** The typo estimate on both stores: a cut closest-words arm gives no estimate. */
describe("a cut closest-words answer says at least, never about", () => {
  it("no estimate for the similar tier; the summary is exact", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    for (let i = 0; i < 12; i++) {
      const id = await seedMessage(db, accountId, mailboxId, { subject: `Voucher ${i}`, snippet: "Use it.", folder: "INBOX" });
      await db.insert(messageBodies).values({ messageId: id, text: "Use it." });
    }
    expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
    const svc = new SearchService();
    const e = await svc.search(ctx, { q: "vo", parts: "estimate", limit: 1 });
    expect({ tier: e.tier, exact: e.totalExact, estimate: e.totalEstimate }).toEqual({ tier: "similar", exact: false, estimate: undefined });
    const s = await svc.search(ctx, { q: "vo", parts: "summary", limit: 1 });
    expect({ tier: s.tier, total: s.total }).toEqual({ tier: "similar", total: 12 });
  });
});

/**
 * EVERY WORD ANYWHERE IN THE LETTER: one word in the subject or sender, another only
 * in the body. The sender word sits in the address too, since the device's index holds the address.
 */
const LETTERS: ReadonlyArray<readonly [key: string, name: string, from: string, subject: string, body: string]> = [
  ["k1", "Kai Brandt", "kai.brandt@brandt.example", "Lanternfish quarterly report", "The harbour survey counted 412 fish."],
  ["k2", "Kai Brandt", "kai.brandt@brandt.example", "Boat schedule", "Bring the lanternfish samples."],
  ["k3", "Lumen Shop", "orders@lumen.example", "Invoice 4471 aquarium supplies", "Thank you for your order of lanternfish food."],
  ["k4", "Fish Digest", "weekly@fishdigest.example", "Weekly digest deep sea", "This week: why the lanternfish glows."],
  ["k5", "Kai Brandt", "kai.brandt@brandt.example", "Old harbour note", "A year-old note about the lanternfish survey."],
  ["a1", "Anna Weber", "anna@weber.ch", "Dinner on Friday", "See you at the club after work."],
  ["r1", "Ledger Desk", "desk@ledger.example", "Re: Quarterly figures", "Please enter the numbers."],
];
const ACROSS: ReadonlyArray<readonly [q: string, keys: readonly string[]]> = [
  ["lanternfish", ["k1", "k2", "k3", "k4", "k5"]],
  ["kai lanternfish", ["k1", "k2", "k5"]], ["from:kai lanternfish", ["k1", "k2", "k5"]], ["from:kai survey", ["k1", "k5"]],
  ["aquarium food", ["k3"]], ["from:lumen food", ["k3"]], ["glows digest", ["k4"]],
  ["lanternfish survey", ["k1", "k5"]], ['"lanternfish survey"', ["k5"]], ["kai samples or food", ["k2", "k3"]],
  ["kai -lanternfish", []], ["lantern kai", ["k1", "k2", "k5"]],
  // An exclusion beside one word in either part, and beside two words apart.
  ["harbour -samples", ["k1", "k5"]], ["kai survey -samples", ["k1", "k5"]],
];
/** One typed operand keeps its words in one part: each letter holds the operand's words only apart. */
const APART: ReadonlyArray<readonly [q: string, key: string]> = [["anna@club.ch", "a1"], ["club.ch", "a1"], ["re-enter", "r1"]];

/** A newer letter, `j` its place: `newer` of them are seeded after the letters, each keyed `f<j>`. */
type Filler = (j: number) => readonly [name: string, from: string, subject: string, body: string];

/** The letters in a fresh account, read by `svc`; `backfill: false` leaves the older columns to answer until `fill`. */
async function lettersStore(
  backfill: boolean, newer?: { count: number; letter: Filler },
  base: ReadonlyArray<readonly [key: string, name: string, from: string, subject: string, body: string | null]> = LETTERS,
) {
  const { db, ctx, accountId, mailboxId } = await makeCtx();
  const keyOf = new Map<string, string>();
  const index = new SearchIndex();
  // A `null` body is a letter whose body row is not there yet (a mirror's row before its body walk).
  for (const [i, [key, name, from, subject, body]] of base.entries()) {
    const date = new Date(Date.parse("2026-07-20T09:00:00Z") - i * 86_400_000);
    const id = await seedMessage(db, accountId, mailboxId, { subject, from, fromName: name, snippet: body ?? "", folder: "INBOX", date });
    if (body !== null) await db.insert(messageBodies).values({ messageId: id, text: body });
    keyOf.set(id, key);
    index.add({ ...engineMessage(id, subject, body ?? "", i), from: { name, address: from } });
  }
  for (let j = 0; j < (newer?.count ?? 0); j++) {
    const [name, from, subject, body] = newer!.letter(j);
    const date = new Date(Date.parse("2026-07-21T09:00:00Z") + j * 60_000);
    const id = await seedMessage(db, accountId, mailboxId, { subject, from, fromName: name, snippet: body, folder: "INBOX", date });
    await db.insert(messageBodies).values({ messageId: id, text: body });
    keyOf.set(id, `f${j}`);
  }
  const fill = async () => expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
  if (backfill) await fill();
  return {
    device: dialect(db).name === "sqlite", fill,
    read: async (svc: SearchService, q: string) => {
      const r = await svc.search(ctx, { q, limit: 50 });
      return { tier: r.tier, keys: r.items.map((m) => keyOf.get(m.id)!).sort() };
    },
    mirror: (q: string) => index.search(q, { limit: 50 }).items.map((h) => keyOf.get(h.message.id)!).sort(),
    /** The three answers a client reads at `limit`: the page, the estimate and the summary. */
    told: async (svc: SearchService, q: string, limit: number, sort?: SearchSort) => {
      const page = await svc.search(ctx, { q, limit, parts: "page", ...(sort ? { sort } : {}) });
      const estimate = await svc.search(ctx, { q, limit, parts: "estimate" });
      const summary = await svc.search(ctx, { q, limit, parts: "summary" });
      return { page, estimate, summary, keys: page.items.map((m) => keyOf.get(m.id)!).sort() };
    },
  };
}

/** Each query's answer; one that matches nothing may fall to either tier, and must hold no letter there. */
async function answers(read: (q: string) => Promise<{ tier: string; keys: string[] }>, table: typeof ACROSS) {
  const got: Array<{ q: string; tier: string; keys: string[] }> = [];
  for (const [q] of table) got.push({ q, ...(await read(q)) });
  return { got, want: table.map(([q, keys], i) => ({ q, tier: keys.length === 0 ? got[i]!.tier : "exact", keys: [...keys] })) };
}

describe("every word anywhere in the letter, on every store", () => {
  let store: Awaited<ReturnType<typeof lettersStore>>;
  beforeAll(async () => { store = await lettersStore(true); }, 60_000);

  for (const [label, svc] of [["the store", new SearchService()], ["the desktop's own store", new SearchService({ indexFills: true, localStore: true })]] as const) {
    it(`${label} answers each query in the exact tier; an excluded word keeps every letter holding it out`, async () => {
      const { got, want } = await answers((q) => store.read(svc, q), ACROSS);
      expect(got).toEqual(want);
    });

    it(`${label} never joins one operand's words across parts (an address, a domain, a hyphenated word)`, async () => {
      const joined: Array<{ q: string; keys: string[] }> = [];
      for (const [q, key] of APART) {
        const r = await store.read(svc, q);
        if (r.tier === "exact" && r.keys.includes(key)) joined.push({ q, keys: r.keys });
      }
      expect(joined).toEqual([]);
    });
  }

  it("rule 2: the mirror answers a subset (it reads no phrase and no exclusion)", () => {
    const plain = ACROSS.filter(([q]) => !/["-]/.test(q));
    expect(plain.filter(([q, keys]) => !store.mirror(q).every((k) => keys.includes(k))).map(([q]) => ({ q, mirror: store.mirror(q) }))).toEqual([]);
  });

  it("before the backfill a letter is read per part (the older columns); its document joins the parts", async () => {
    const before = await lettersStore(false);
    const svc = new SearchService();
    // The device's FTS tables cover every row, so it has no before.
    const apart = (keys: string[]): string[] => (before.device ? keys : []);
    const table: typeof ACROSS = [
      ["aquarium food", apart(["k3"])], ["harbo lanternf", apart(["k1", "k5"])], ["lanternfish survey", before.device ? ["k1", "k5"] : ["k5"]],
      ['"lanternfish survey"', ["k5"]], ["thank lanternfish", ["k3"]],
    ];
    const exact: Array<{ q: string; keys: string[] }> = [];
    for (const [q] of table) { const r = await before.read(svc, q); exact.push({ q, keys: r.tier === "exact" ? r.keys : [] }); }
    expect(exact).toEqual(table.map(([q, keys]) => ({ q, keys: [...keys] })));
    await before.fill();
    const { got, want } = await answers((q) => before.read(svc, q), ACROSS.filter(([q]) => table.some(([t]) => t === q)));
    expect(got).toEqual(want);
  });
});

/**
 * AN EXCLUSION PAST THE NEWEST MAIL. At limit 5 an arm cuts at K = 20 and walks the newest 120
 * letters; 130 newer letters hold none of the words, so a letter older than them is found off the
 * indexes or not at all. Each answer the client reads agrees with the summary: a page or an
 * estimate that says it is exact counts what the summary counts.
 */
describe("an exclusion past the newest mail: the older letters are found, and a cut arm says so", () => {
  const told = (r: Awaited<ReturnType<Awaited<ReturnType<typeof lettersStore>>["told"]>>) => ({
    tier: r.page.tier, keys: r.keys, summary: r.summary.total,
    page: r.page.totalExact ? r.page.total : "cut", estimate: r.estimate.totalExact ? r.estimate.total : "cut",
  });

  it("two words apart, an or of two words, and each word in either part, beside an exclusion", async () => {
    const store = await lettersStore(true, { count: 130, letter: (j) => ["Robot Desk", "status@robot.example", `Status ${j}`, `All systems nominal, run ${j}.`] });
    const table: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["kai survey -samples", ["k1", "k5"]], ["kai or food -samples", ["k1", "k3", "k5"]], ["zebra or food -samples", ["k3"]],
      ["harbour -samples", ["k1", "k5"]], ["kai survey or food -samples", ["k1", "k3", "k5"]], ["zebra or kai survey -samples", ["k1", "k5"]],
    ];
    const got = [];
    for (const [q] of table) got.push({ q, ...told(await store.told(new SearchService(), q, 5)) });
    expect(got).toEqual(table.map(([q, keys]) => ({ q, tier: "exact", keys: [...keys], summary: keys.length, page: keys.length, estimate: keys.length })));
  }, 60_000);

  it("words dense in the newest mail with every newest match excluded: the walk goes on and finds the older letters", async () => {
    // 130 newer letters from Kai with `survey` and `samples` in the body.
    const store = await lettersStore(true, { count: 130, letter: (j) => ["Kai Brandt", "kai.brandt@brandt.example", `Field log ${j}`, `Survey samples batch ${j}.`] });
    const got = [];
    for (const q of ["kai survey -samples", "kai survey or quarterly -samples"]) got.push({ q, ...told(await store.told(new SearchService(), q, 5)) });
    expect(got).toEqual([
      { q: "kai survey -samples", tier: "exact", keys: ["k1", "k5"], summary: 2, page: 2, estimate: 2 },
      { q: "kai survey or quarterly -samples", tier: "exact", keys: ["k1", "k5", "r1"], summary: 3, page: 3, estimate: 3 },
    ]);
  }, 60_000);

  it("a deeper walk that falls short with mail past it says the arm is cut, and adds no row", async () => {
    // 830 newer letters, the newest five about dog food: the walk keeps five of the newest 120, which
    // at that rate fill K inside the deeper walk of 800, so it walks on and finds none; k3 is older.
    // The page holds five of six: the device counts k3, the server says its count is cut.
    const store = await lettersStore(true, {
      count: 830, letter: (j) => (j >= 825 ? ["Pet Shop", "orders@pets.example", `Order ${j}`, `Dog food order ${j}.`]
        : ["Robot Desk", "status@robot.example", `Status ${j}`, `All systems nominal, run ${j}.`]),
    });
    const r = told(await store.told(new SearchService(), "food -samples", 5));
    const newest = ["f825", "f826", "f827", "f828", "f829"];
    expect(r).toEqual(store.device
      ? { tier: "exact", keys: newest, summary: 6, page: 6, estimate: 6 }
      : { tier: "exact", keys: newest, summary: 6, page: "cut", estimate: "cut" });
  }, 120_000);

  it("an arm whose newest matches all hold the excluded word reads as cut, rows or none", async () => {
    // Under 20 newest letters holding none of the words, 130 from Kai with `survey` and `samples`:
    // the words look sparse, so the two-word group is read off the index, and its newest 120 all
    // hold `samples`; `quarterly` finds k1 and r1 in the subject.
    const store = await lettersStore(true, {
      count: 150, letter: (j) => (j >= 130 ? ["Robot Desk", "status@robot.example", `Status ${j}`, `All systems nominal, run ${j}.`]
        : ["Kai Brandt", "kai.brandt@brandt.example", `Field log ${j}`, `Survey samples batch ${j}.`]),
    });
    const r = told(await store.told(new SearchService(), "kai survey or quarterly -samples", 5));
    // k1 and k5 hold both words apart, r1 holds `quarterly`; k2 holds `samples`.
    expect({ tier: r.tier, summary: r.summary, hasK1: r.keys.includes("k1"), others: r.keys.filter((k) => !["k1", "k5", "r1"].includes(k)) })
      .toEqual({ tier: "exact", summary: 3, hasK1: true, others: [] });
    // Exact only when it counts what the summary counts: the device reads every match, the server's
    // text arm read the bound of newest matches and kept none, so it says it was cut.
    const said = store.device ? r.summary : "cut";
    expect({ page: r.page, estimate: r.estimate }).toEqual({ page: said, estimate: said });
    // One group alone: its arm is cut with no row, and the page is still the exact tier and cut,
    // never closest-word guesses said to be exact; the estimate, with no candidate, counts the set whole.
    const one = told(await store.told(new SearchService(), "kai survey -samples", 5));
    expect(one).toEqual(store.device
      ? { tier: "exact", keys: ["k1", "k5"], summary: 2, page: 2, estimate: 2 }
      : { tier: "exact", keys: [], summary: 2, page: "cut", estimate: 2 });
  }, 60_000);

  it("words dense in the newest mail, every match the deeper walk reads excluded: cut, never guesses", async () => {
    // 830 newer letters from Kai, each with `survey` and `samples`: the walk goes on to 800 and keeps none.
    const store = await lettersStore(true, { count: 830, letter: (j) => ["Kai Brandt", "kai.brandt@brandt.example", `Field log ${j}`, `Survey samples batch ${j}.`] });
    const r = told(await store.told(new SearchService(), "kai survey -samples", 5));
    expect(r).toEqual(store.device
      ? { tier: "exact", keys: ["k1", "k5"], summary: 2, page: 2, estimate: 2 }
      : { tier: "exact", keys: [], summary: 2, page: "cut", estimate: 2 });
  }, 120_000);
});

/**
 * THE SUBJECT'S LAST WORD BESIDE A BODY WORD (a tester's shape on 0.30.3): each pair is found, and
 * no document joins the subject and the body with nothing between them — the last subject word and
 * the first body word never read as one word, nor as a phrase.
 */
describe("the subject's last word beside a body word", () => {
  const SUBJECT_LAST: ReadonlyArray<readonly [key: string, name: string, from: string, subject: string, body: string]> = [
    ["b1", "Kai Brandt", "kai.brandt@brandt.example", "Lanternfish survey results", "Table: the survey counted photos of each lanternfish."],
    ["b2", "Lab Desk", "desk@lab.example", "Glowing tank", "Hello, it glows at night."],
    ["b3", "Kai Brandt", "kai.brandt@brandt.example", "Old harbour note", "Aquarium prices went up."],
    ["b4", "Lumen Shop", "orders@lumen.example", "Your order", "Bag ships Monday."],
  ];
  const FOUND: ReadonlyArray<readonly [q: string, keys: readonly string[]]> = [
    ["results table", ["b1"]], ["tank glows", ["b2"]], ["tank hello", ["b2"]], ["note aquarium", ["b3"]], ["order bag", ["b4"]],
    ["survey table", ["b1"]], ["photos lanternfish", ["b1"]],
  ];
  /** The two words run together, and the two as a phrase: what a join with no separator would find. */
  const JOINED = ["resultstable", "tankhello", "noteaquarium", "orderbag", '"results table"', '"tank hello"', '"order bag"'];
  let read: (svc: SearchService, q: string) => Promise<{ tier: string; keys: string[] }>;
  let mirror: (q: string) => string[];
  beforeAll(async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const keyOf = new Map<string, string>();
    const index = new SearchIndex();
    for (const [i, [key, name, from, subject, body]] of SUBJECT_LAST.entries()) {
      const date = new Date(Date.parse("2026-07-20T09:00:00Z") - i * 86_400_000);
      const id = await seedMessage(db, accountId, mailboxId, { subject, from, fromName: name, snippet: body, folder: "INBOX", date });
      await db.insert(messageBodies).values({ messageId: id, text: body });
      keyOf.set(id, key);
      index.add({ ...engineMessage(id, subject, body, i), from: { name, address: from } });
    }
    expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
    read = async (svc, q) => {
      const r = await svc.search(ctx, { q, limit: 50 });
      return { tier: r.tier, keys: r.items.map((m) => keyOf.get(m.id)!).sort() };
    };
    mirror = (q) => index.search(q, { limit: 50 }).items.map((h) => keyOf.get(h.message.id)!).sort();
  }, 60_000);

  for (const [label, svc] of [["the store", new SearchService()], ["the desktop's own store", new SearchService({ indexFills: true, localStore: true })]] as const) {
    it(`${label} finds each pair in the exact tier, and never the two run together`, async () => {
      const { got, want } = await answers((q) => read(svc, q), FOUND);
      expect(got).toEqual(want);
      const joined: Array<{ q: string; keys: string[] }> = [];
      for (const q of JOINED) {
        const r = await read(svc, q);
        if (r.tier === "exact" && r.keys.length > 0) joined.push({ q, keys: r.keys });
      }
      expect(joined).toEqual([]);
    });
  }

  it("the mirror never runs the two together either, and answers a subset", () => {
    expect(JOINED.filter((q) => !q.startsWith('"')).map((q) => ({ q, keys: mirror(q) })).filter((r) => r.keys.length > 0)).toEqual([]);
    expect(FOUND.filter(([q, keys]) => !mirror(q).every((k) => keys.includes(k))).map(([q]) => ({ q, mirror: mirror(q) }))).toEqual([]);
  });
});

/**
 * A file name's later parts beside another word: `ledger` alone found the letter, `ines ledger` did not.
 * The document's head vector holds the parts as words. NAMES, the device apart: its word index holds
 * the subject, the sender's address and the text (mail 0138), so a name, a recipient or a file name
 * is read there only as the whole query inside the header text, and these cases are the server's.
 */
describe("each part of a file name beside another word", () => {
  const FILES: ReadonlyArray<readonly [key: string, name: string, from: string, subject: string, body: string, file: string]> = [
    ["sr2", "Ines Varga", "iv@post.example", "Papers tq92c7557f21 SR2", "SR2: the scan is attached.", "harbour-ledger-7731.pdf"],
    ["d2", "Port Office", "office@port.example", "Ledger copy", "The harbour scan.", "notes.txt"],
  ];
  const FOUND: ReadonlyArray<readonly [q: string, keys: readonly string[]]> = [
    ["ledger", ["d2", "sr2"]], ["ines harbour", ["sr2"]], ["ines ledger", ["sr2"]], ["ines pdf", ["sr2"]], ["ines 7731", ["sr2"]],
    ["ines harbour-ledger-7731.pdf", ["sr2"]], ["scan pdf", ["sr2"]], ["scan 7731", ["sr2"]], ["papers ledger", ["sr2"]],
    ["harbour ledger", ["d2", "sr2"]], ["ledger 7731 scan", ["sr2"]], ["ines harbour 7731", ["sr2"]],
    ["Ines LEDGER", ["sr2"]], ["SCAN Pdf 7731", ["sr2"]],
  ];
  /** A phrase reads whole words, and the start of a part is no word of the letter. */
  const NOT_EXACT = ['"ines ledger"', "ines 77"];
  let read: (svc: SearchService, q: string) => Promise<{ tier: string; keys: string[] }>;
  let device = false;
  beforeAll(async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    device = dialect(db).name === "sqlite";
    const keyOf = new Map<string, string>();
    for (const [i, [key, name, from, subject, body, file]] of FILES.entries()) {
      const date = new Date(Date.parse("2026-07-20T09:00:00Z") - i * 86_400_000);
      const id = await seedMessage(db, accountId, mailboxId, { subject, from, fromName: name, snippet: body, folder: "INBOX", date });
      await db.insert(messageBodies).values({ messageId: id, text: body });
      await db.insert(attachments).values({ accountId, messageId: id, filename: file, contentType: "application/pdf" });
      keyOf.set(id, key);
    }
    expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
    read = async (svc, q) => {
      const r = await svc.search(ctx, { q, limit: 50 });
      return { tier: r.tier, keys: r.items.map((m) => keyOf.get(m.id)!).sort() };
    };
  }, 60_000);

  for (const [label, svc] of [["the store", new SearchService()], ["the desktop's own store", new SearchService({ indexFills: true, localStore: true })]] as const) {
    it(`${label} finds the letter by any part of its file name beside another word, in the exact tier`, async (t) => {
      if (device) t.skip(); // NAMES, above
      const { got, want } = await answers((q) => read(svc, q), FOUND);
      expect(got).toEqual(want);
      const exact: Array<{ q: string; keys: string[] }> = [];
      for (const q of NOT_EXACT) {
        const r = await read(svc, q);
        if (r.tier === "exact" && r.keys.length > 0) exact.push({ q, keys: r.keys });
      }
      expect(exact).toEqual([]);
    });
  }
});

/**
 * NOTHING MATCHES EXACTLY, AND EVERY NEWEST LETTER WITH THE WORDS HOLDS THE EXCLUDED ONE (a reviewer's
 * shape): three older letters only resemble the query, 130 newer ones from Kai hold `survey` and
 * `samples`, 20 newest hold none. The page, the estimate and the summary answer ONE tier, in every
 * order: an exact tier says 0 over its empty list, never the closest words' count, and closest words
 * are said as such over their own letters.
 */
describe("no exact match behind a cut exact tier: one tier on every answer", () => {
  const GUESSES: ReadonlyArray<readonly [string, string, string, string, string]> = [
    ["g1", "Kia Brand", "kia@brand.example", "Kia survy results", "Numbers from the field."],
    ["g2", "Lab Desk", "desk@lab.example", "Servey notes", "Notes from Tuesday."],
    ["g3", "Kai Brandt", "kai.brandt@brandt.example", "Kai surveyor visit", "The visit is on Monday."],
  ];

  it("the page in each order, the estimate and the summary agree on the tier and the count", async () => {
    const store = await lettersStore(true, {
      count: 150, letter: (j) => (j >= 130 ? ["Robot Desk", "status@robot.example", `Status ${j}`, `All systems nominal, run ${j}.`]
        : ["Kai Brandt", "kai.brandt@brandt.example", `Field log ${j}`, `Survey samples batch ${j}.`]),
    }, GUESSES);
    const got = [];
    for (const sort of ["relevance", "date_desc"] as const) {
      const r = await store.told(new SearchService(), "kai survey -samples", 5, sort);
      got.push({
        sort, tier: r.page.tier, keys: r.keys, estimateTier: r.estimate.tier, summaryTier: r.summary.tier,
        estimate: r.estimate.totalExact ? r.estimate.total : "cut", summary: r.summary.total,
      });
    }
    // No letter holds both words without `samples`: an exact answer is empty and says 0.
    expect(got).toEqual(got.map((g) => ({
      ...g, estimateTier: g.tier, summaryTier: g.tier,
      ...(g.tier === "exact" ? { keys: [], estimate: 0, summary: 0 } : { summary: g.keys.length, keys: g.keys.filter((k) => k.startsWith("g")) }),
    })));
  }, 60_000);
});

/**
 * AN EXCLUDED WORD BESIDE A LETTER WITH NO BODY ROW (a mirror's row before its body walk, a letter
 * whose body was withheld): the letter holds no excluded word, so it stays.
 */
describe("an excluded word keeps a letter whose body row is not there", () => {
  const BASE: ReadonlyArray<readonly [string, string, string, string, string | null]> = [
    ["h1", "Port Office", "office@port.example", "Harbour survey plan", null],
    ["h2", "Port Office", "office@port.example", "Harbour samples", "Collected on Monday."],
    ["h3", "Kai Brandt", "kai.brandt@brandt.example", "Old harbour note", "Bring the samples."],
    ["h4", "Port Office", "office@port.example", "Harbour hours", "Open at nine."],
  ];
  for (const [label, svc] of [["the store", new SearchService()], ["the desktop's own store", new SearchService({ indexFills: true, localStore: true })]] as const) {
    it(`${label} finds the body-less letter beside the bodied ones`, async () => {
      const store = await lettersStore(true, undefined, BASE);
      const got = [];
      for (const q of ["harbour -samples", "harbour survey -samples", "port -samples"]) got.push({ q, ...(await store.read(svc, q)) });
      expect(got).toEqual([
        { q: "harbour -samples", tier: "exact", keys: ["h1", "h4"] },
        { q: "harbour survey -samples", tier: "exact", keys: ["h1"] },
        { q: "port -samples", tier: "exact", keys: ["h1", "h4"] },
      ]);
    }, 60_000);
  }
});
