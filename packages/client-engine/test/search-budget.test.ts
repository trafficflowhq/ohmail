import { describe, expect, it } from "vitest";
import { SearchIndex } from "../src/search.js";
import type { EngineMessage } from "../src/types.js";

/**
 * THE LOCAL INDEX AT A LARGE MAILBOX'S SIZE — a budget, in milliseconds, because that is the unit the
 * cost is paid in.
 *
 * `engine.search()` is SYNCHRONOUS and answers on every keystroke. Its cost is main-thread time
 * in the middle of typing, so a regression here is not a slower search — it is a text box that
 * stops keeping up with the person using it.
 *
 * ── WHY THIS EXISTS BESIDE THE BROWSER PERF HARNESS ─────────────────────────────────────────
 *
 * They measure two different things and neither replaces the other. The browser harness drives the REAL shell in
 * headless Chromium and asks the engine that just finished a bootstrap drain, so it covers the
 * index as the product actually holds it — and it is the harness's own large world.
 * This file measures the index ALONE, with no browser: it runs in the ordinary suite, on any
 * machine, in a git worktree, and in CI. That last part is not hypothetical — the harness needs
 * a Chromium and a react resolution that a fresh worktree does not have (measured 2026-09-03:
 * it dies at mount with `Cannot read properties of null (reading 'useMemo')`, on HEAD as well as
 * on this branch), and a budget nobody can run is not a budget.
 *
 * ── THE THREE SHAPES, AND WHY ONLY ONE OF THEM IS COMMON ────────────────────────────────────
 *
 *   · BUILD  — walks every message once. Paid on the first search after a mirror change and
 *              then cached, so it is amortised over the keystrokes that follow. On a mirror
 *              past `SEARCH_INDEX_SYNC_MAX` the engine pays it in 16 ms slices off the
 *              keystroke path instead; this file measures the walk itself.
 *   · EXACT  — a query WITH an answer. Literal arms only: a map lookup plus one pass over the
 *              term list. This is what typing normally costs.
 *   · MISS   — a query with no literal answer. The ONLY shape that runs the trigram arm over
 *              every indexed term, and the reason the tier rule is a performance change as well
 *              as a ranking one: before it, every search paid this on every keystroke.
 *
 * ── THE MEASURED NUMBERS THE BUDGETS BELOW ARE SET FROM (2026-09-03, at `N`) ────────────────
 *
 *      index build              473    ms   (bodies indexed; a later fix removed them — see below)
 *      exact tier, one token      0.74 ms
 *      exact tier, two tokens     1.97 ms
 *      no literal answer          3.34 ms   ← the only shape that runs the trigram arm
 *
 * The absolute ceilings carry ~20× headroom, because CI hardware is slower and a suite running
 * beside thirty other files is noisy; they exist to catch an order-of-magnitude regression, not
 * to police jitter.
 *
 * ── WHAT CHANGED UNDER THESE NUMBERS (2026-09-13) ───────────────────────────
 *
 * The rows below still carry a `body`, and the index no longer reads it: the build measures
 * subject, sender, recipients and the snippet. The corpus is deliberately
 * unchanged so the queries are the same questions they always were — `kiln` and `kiln schedule`
 * are in the subjects, `zqxbrimm` is in nothing. The ceilings stay where they were: they bound
 * the shape, and a build that got cheaper does not need them lowered to stay a guard.
 *
 * The sharper guard is a COUNT, and it is the one that names this change. A build that put the
 * trigram arm back on the common path would leave every absolute number well inside its ceiling
 * — 3.3 ms is not a slow keystroke — so the no-answer case counts the trigram sets each query
 * reads: none for a query with an answer, every reachable term's for one without. It used to be
 * a ratio of two millisecond medians, which a loaded CI machine compressed below its floor.
 */

const N = 20_000;

const FIRST = ["Lena", "Jonas", "Mara", "Piet", "Nora", "Ivo", "Greta", "Samu", "Anna", "Timo"];
const LAST = ["Berg", "Lindt", "Vogel", "Stein", "Kranz", "Moser", "Ebner", "Falke"];
const DOMAINS = ["atelier.example", "papierwerk.example", "nordpost.example", "buchbund.example"];
const TOPICS = [
  "Q3 planning notes", "Invoice for July", "The kiln schedule", "Re: shelf measurements",
  "Newsletter — new arrivals", "Your order has shipped", "Meeting moved to Thursday",
  "Draft chapter attached", "Studio rent adjustment", "Weekend workshop places",
];

/** Deterministic pseudo-random — the same N gives the same world on every run. */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The same world shape the browser perf harness generates, message for message: real
 * bodies, real snippets, a spread of senders and topics. Copied rather than imported because
 * that file is a browser entry that mounts the whole shell on import.
 */
function world(n: number): EngineMessage[] {
  const rnd = mulberry32(42);
  const out: EngineMessage[] = [];
  for (let i = 0; i < n; i++) {
    const f = FIRST[Math.floor(rnd() * FIRST.length)]!;
    const l = LAST[Math.floor(rnd() * LAST.length)]!;
    const dom = DOMAINS[Math.floor(rnd() * DOMAINS.length)]!;
    const topic = TOPICS[Math.floor(rnd() * TOPICS.length)]!;
    const body =
      `Hello,\n\nthis is message ${i} about ${topic.toLowerCase()}. ` +
      "The paragraphs are long enough to cost what a real body costs to clamp and to paint. " +
      "We looked at the numbers again on Tuesday and the second batch reads better than the first; " +
      "if the glaze holds, the whole series ships before the fair.\n\n" +
      "Two more lines so the snippet and the card diverge the way real mail does.\n\nRegards,\n" + f;
    out.push({
      id: `perf-${i}`,
      accountId: "acct",
      mailboxId: "mb",
      threadId: null,
      messageIdHeader: null,
      subject: `${topic} (${i})`,
      from: { name: `${f} ${l}`, address: `${f.toLowerCase()}@${dom}` },
      to: [],
      cc: [],
      date: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      folder: "ohmail/News",
      snippet: body.slice(0, 200).replace(/\n+/g, " "),
      body,
      unread: i % 17 === 0,
      hasAttachments: false,
      attachmentCount: 0,
      sensitivity: {
        sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
      },
      triage: null,
      labels: [],
      remoteContent: "none",
      updatedAt: "2026-08-04T12:00:00.000Z",
    } as EngineMessage);
  }
  return out;
}

const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

function timed(fn: () => void, runs: number): number {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return Math.round(median(out) * 1000) / 1000;
}

describe(`the local index at ${N} messages`, () => {
  const rows = world(N);

  it("builds the index once, and the build is not paid per keystroke", () => {
    const t = performance.now();
    const idx = new SearchIndex();
    for (const m of rows) idx.add(m);
    const buildMs = performance.now() - t;
    // Reported so a run's numbers are readable, not only its verdict.
    console.log(`  index build at ${N}: ${Math.round(buildMs)} ms, ${idx.coverage().messages} messages`);
    expect(buildMs, `SearchIndex build took ${Math.round(buildMs)} ms at ${N} messages`).toBeLessThan(4000);
  });

  it("a query WITH an answer stays inside a keystroke", () => {
    const idx = new SearchIndex();
    for (const m of rows) idx.add(m);

    const one = timed(() => void idx.search("kiln"), 40);
    const two = timed(() => void idx.search("kiln schedule"), 40);
    console.log(`  exact-tier search: one token ${one} ms, two tokens ${two} ms`);

    // The rule as a property of the measured run: a query with an answer carries no guesses,
    // at a corpus size where running the trigram arm would be plainly visible.
    const res = idx.search("kiln");
    expect(res.tier).toBe("exact");
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.similar).toEqual([]);

    expect(one, `median one-token search ${one} ms`).toBeLessThan(15);
    expect(two, `median two-token search ${two} ms`).toBeLessThan(25);
  });

  it("a query with NO literal answer pays the trigram arm — and only that query does", () => {
    const idx = new SearchIndex();
    for (const m of rows) idx.add(m);

    const miss = timed(() => void idx.search("zqxbrimm"), 20);
    const exact = timed(() => void idx.search("kiln"), 20);
    console.log(`  no-literal-answer search: ${miss} ms (against ${exact} ms with an answer)`);

    /*
     * The bound that makes the tier rule a performance change: the expensive shape must be the
     * rare one. A build that ran the trigram arm on the common path would leave every absolute
     * ceiling above green — 3 ms is not a slow keystroke — so which query runs the arm is
     * COUNTED, not inferred from a ratio of two medians (2.6-4.9x on an idle machine, 1.7x on
     * a loaded CI VM against a 1.8 floor).
     *
     * The count is the index's own `trigramCache` reads: the fuzzy step is its only reader.
     */
    expect(miss, `median no-answer search ${miss} ms`).toBeLessThan(60);

    const cache = (idx as unknown as { trigramCache: Map<string, Set<string>> }).trigramCache;
    expect(cache, "SearchIndex no longer keeps its trigram sets in `trigramCache`").toBeInstanceOf(Map);
    let reads = 0;
    cache.get = (term: string) => { reads += 1; return Map.prototype.get.call(cache, term) as Set<string> | undefined; };
    const readsOf = (q: string): number => { reads = 0; idx.search(q); return reads; };
    const exactReads = readsOf("kiln");
    const missReads = readsOf("zqxbrimm");
    console.log(`  trigram sets read: ${missReads} with no answer, ${exactReads} with one`);
    expect(exactReads, "a query with an answer ran the trigram arm").toBe(0);
    expect(missReads, "a query with no literal answer did not run the trigram arm").toBeGreaterThan(0);
  });

  /**
   * THE FOURTH SHAPE — a query that tokenizes to NOTHING, which is answered by a scan.
   *
   * `x`, `#4`, `y@d`: every run of letters and digits in them is a single character, so the
   * postings map cannot answer them at all and the index matches the string verbatim over every
   * message's subject and sender. That is O(messages) by construction, and it is on the common
   * path in one specific way worth measuring: it is the FIRST KEYSTROKE of every ordinary query.
   * A person typing `invoice` pays it once, for `i`, before the postings map takes over.
   *
   * Measured here at `N` messages so the cost is a number rather than an argument:
   * **8.8 ms** for a character that matches nearly the whole mirror, **2.3 ms** for one that
   * matches nothing. The first version of the arm measured 25.7 ms, and the difference is
   * `search.ts`'s reason for ordering on a precomputed date key — `rank`'s comparator parses
   * `Date:` on both sides of every comparison, which is hundreds of thousands of parses when a scan matches
   * most of the rows. The ceilings carry the same ~20×-ish headroom as the others in this file, and
   * they exist to catch that shape coming back rather than to police a millisecond.
   */
  it("a query that tokenizes to nothing is a scan, and the scan fits in a keystroke", () => {
    const idx = new SearchIndex();
    for (const m of rows) idx.add(m);

    const first = timed(() => void idx.search("i"), 20);
    const none = timed(() => void idx.search("§"), 20);
    console.log(`  verbatim scan: one hit-heavy char ${first} ms, one that matches nothing ${none} ms`);

    // It ANSWERS, which is the point of it — the corpus's senders are `first@domain`, so a
    // single letter finds mail. A green ceiling over an empty answer would measure nothing.
    expect(idx.search("i").items.length).toBeGreaterThan(0);
    expect(idx.search("§").items).toEqual([]);

    expect(first, `median verbatim scan ${first} ms`).toBeLessThan(120);
    expect(none, `median verbatim scan with no match ${none} ms`).toBeLessThan(60);
  });
});
