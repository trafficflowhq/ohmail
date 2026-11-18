import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { SIMILAR_FLOOR } from "@trafficflow/core/search-rank";
import { SearchIndex } from "../src/search.js";

/**
 * THE RANKING TABLE — one fixed corpus, and every claim the search rule makes, as a row.
 *
 * The complaint this answers was that typo tolerance "can distort the results very much". It
 * could, and the distortion had two shapes, both measured on the demo corpus before this:
 *
 *   · **An exact match demoted.** Scoring was `field weight × match quality`, so a trigram guess
 *     against a SUBJECT (×3) outscored a literal match in a BODY (×1). The query `graphite` put
 *     "Fotos vom Grat" — a mountain ridge — above the message whose body says `graphite`.
 *   · **A one-answer query returning twenty rows.** The fuzzy arm had no floor on the length of
 *     the term it matched AGAINST, so `invoce` reached nineteen unrelated messages through the
 *     two-letter word `in`, and `anna` reached twelve through `and`.
 *
 * The corpus below is built so each row of the table isolates one claim. It is deliberately
 * hand-written rather than taken from the demo fixtures: a fixture edited by another slice
 * would silently change what this file proves.
 */

const BASE = {
  accountId: "acct",
  mailboxId: "mb",
  threadId: null,
  messageIdHeader: null,
  to: [],
  cc: [],
  folder: "ohmail/News",
  unread: false,
  hasAttachments: false,
  attachmentCount: 0,
  sensitivity: {
    sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
  },
  triage: null,
  labels: [],
  remoteContent: "none",
  updatedAt: "2026-08-04T12:00:00.000Z",
} as const;

function msg(o: {
  id: string;
  subject: string;
  from?: string;
  fromName?: string | null;
  snippet?: string;
  date?: string;
}): EngineMessage {
  return {
    ...BASE,
    id: o.id,
    subject: o.subject,
    from: { name: o.fromName ?? null, address: o.from ?? "someone@example.test" },
    snippet: o.snippet ?? "",
    date: o.date ?? "2026-08-01T09:00:00.000Z",
  } as EngineMessage;
}

/**
 * THE CORPUS. Eight messages, each earning its place in at least one row of the table.
 *
 * `grat` and `walk` exist to be trigram-similar to a query without containing it; `invoice`
 * exists so `invoce` has one right answer and `invite` a wrong one; the two `glaze evening`
 * rows differ only in whether the words are adjacent; `in` is planted as a real indexed term so
 * the short-term floor is proven against a term that is actually in the index.
 */
function corpus(): SearchIndex {
  const idx = new SearchIndex();
  for (const m of [
    /*
     * The literal match that used to lose to a guess: `graphite` is in the weakest field this
     * index reads and nowhere else. That field was the BODY until the instant index stopped
     * reading bodies; it is the SNIPPET now, which carries the same `FIELD_WEIGHT.text` — so
     * the row measures the same contest (weight 1 literal against weight 3 guess) through the
     * field the index actually holds.
     */
    msg({
      id: "sketch",
      subject: "Notes from the studio",
      from: "ben@lichtgrat.example",
      snippet: "The graphite sketch came out well.",
      date: "2026-07-20T09:00:00.000Z",
    }),
    // The guess that used to win: trigram-similar to `graphite`, in the SUBJECT.
    msg({ id: "ridge", subject: "Fotos vom Grat", from: "post@gratbrief.example" }),
    // The typo case's right answer, and a wrong one close behind it.
    msg({ id: "invoice", subject: "Invoice 078 for the workshop", from: "billing@erdton.example" }),
    msg({ id: "invite", subject: "Invite: tech check", from: "petra@makersfest.example" }),
    /*
     * Phrase versus bag, and the two are matched on EVERYTHING ELSE deliberately: both carry
     * both tokens in the SUBJECT, so both earn the same field weights and the same token
     * scores. The only thing left to separate them is adjacency. An earlier version of this
     * pair had the bag's second word in the body — it ranked correctly for the wrong reason
     * (3+1 against 3+3) and stayed green with the phrase bonus zeroed out, which is a row that
     * looks like a guard and is not.
     */
    msg({ id: "phrase", subject: "Glaze evening in September", from: "nadja@erdton.example" }),
    msg({ id: "bag", subject: "Evening in the studio, then glaze", from: "nadja@erdton.example" }),
    /*
     * Two messages that tie on relevance and differ only in date. The ids are chosen so that
     * ALPHABETICAL order contradicts date order: `aaa-old` is older, `zzz-new` is newer, so a
     * comparator that dropped the date and fell through to the id tail would answer
     * `[aaa-old, zzz-new]` — the wrong order — instead of quietly agreeing by coincidence.
     */
    msg({ id: "aaa-old", subject: "Kiln service", date: "2026-07-01T09:00:00.000Z" }),
    msg({ id: "zzz-new", subject: "Kiln service", date: "2026-07-30T09:00:00.000Z" }),
    /*
     * The NEWEST message in the corpus, and the WEAKEST match for `studio` — it says the word
     * in its snippet while the two above say it in their subjects. Recency as a driver would put
     * it first; recency as a tie-break leaves it last.
     */
    msg({ id: "recent-weak", subject: "Nothing much", snippet: "studio", date: "2026-08-20T09:00:00.000Z" }),
    // A short common word, present as a real indexed term, for the short-term floor.
    msg({ id: "short", subject: "In", from: "brief@example.test" }),
  ]) {
    idx.add(m);
  }
  return idx;
}

const ids = (hits: { message: EngineMessage }[]) => hits.map((h) => h.message.id);

describe("the search ranking table", () => {
  it("row 1 — an EXACT match is never below a guess: `graphite` answers with the snippet match alone", () => {
    const res = corpus().search("graphite");
    expect(res.tier).toBe("exact");
    // The snippet match is the answer…
    expect(ids(res.items)).toEqual(["sketch"]);
    // …and the ridge, which used to sit ABOVE it on a subject-weighted trigram score, is not
    // offered at all: there was an exact hit, so no guess is made.
    expect(res.similar).toEqual([]);
    expect(ids(res.items)).not.toContain("ridge");
  });

  it("row 2 — a typo'd query surfaces under `similar` ONLY, with the right answer on top", () => {
    const res = corpus().search("invoce");
    expect(res.items).toEqual([]);
    expect(res.tier).toBe("similar");
    expect(res.similar[0]?.message.id).toBe("invoice");
    // The guess is annotated with the term it reached, which is what the row's capsule renders.
    expect(res.similar[0]?.matches.some((m) => m.fuzzy && m.term === "invoice")).toBe(true);
  });

  it("row 3 — a typo'd SENDER surfaces the same way", () => {
    const idx = corpus();
    idx.add(msg({ id: "petra", subject: "Your talk is in", from: "petra@makersfest.example" }));
    const res = idx.search("petar");
    expect(res.items).toEqual([]);
    expect(ids(res.similar)).toContain("petra");
  });

  it("row 4 — guesses are withheld the moment ONE exact hit exists", () => {
    // `invoice` matches literally, so the same corpus that offered `invite` as a guess for the
    // typo offers nothing at all here. This is the floor, and it is the whole complaint.
    const res = corpus().search("invoice");
    expect(res.tier).toBe("exact");
    expect(ids(res.items)).toEqual(["invoice"]);
    expect(res.similar).toEqual([]);
  });

  it("row 5 — a PHRASE beats the same words scattered in the same field", () => {
    const res = corpus().search("glaze evening");
    expect(res.tier).toBe("exact");
    // Both subjects carry both tokens, so the token scores are equal and ONLY the phrase bonus
    // separates them. Zero the bonus and this row goes red, which is the point of matching the
    // pair on field weight.
    expect(ids(res.items)).toEqual(["phrase", "bag"]);
    expect(res.items[0]!.score).toBeGreaterThan(res.items[1]!.score);
  });

  it("row 6 — recency is a TIE-BREAK and not a driver", () => {
    const res = corpus().search("kiln service");
    // Equal relevance, so the newer one leads — and the ids are chosen so that falling through
    // to the id tail would give the OPPOSITE order, which is what makes this an assertion about
    // the date rather than a coincidence.
    expect(ids(res.items)).toEqual(["zzz-new", "aaa-old"]);
    expect(res.items[0]!.score).toBe(res.items[1]!.score);
    // And the other half of "tie-break, not driver": the NEWEST message in the corpus is the
    // LAST result for `studio`, because it says the word in its snippet while the other two say
    // it in their subjects. If the date led the ordering it would be first.
    const weighted = corpus().search("studio");
    expect(ids(weighted.items).at(-1)).toBe("recent-weak");
    expect(ids(weighted.items)).toEqual(["bag", "sketch", "recent-weak"]);
  });

  it("row 7 — an undated message sorts LAST, never first", () => {
    const idx = new SearchIndex();
    idx.add(msg({ id: "dated", subject: "Kiln service", date: "2026-07-01T09:00:00.000Z" }));
    idx.add({ ...msg({ id: "undated", subject: "Kiln service" }), date: null } as EngineMessage);
    expect(ids(idx.search("kiln service").items)).toEqual(["dated", "undated"]);
  });

  it("row 8 — a SHORT indexed term is never a typo target: `anna` does not reach `in`", () => {
    const idx = corpus();
    // `in` IS in the index (the `short` message's subject), and its trigram similarity to a
    // four-letter query clears the threshold. The floor on the TERM is what excludes it — and
    // without that floor this one word dragged nineteen messages into a one-answer query.
    const res = idx.search("inno");
    expect(ids(res.items)).not.toContain("short");
    expect(ids(res.similar)).not.toContain("short");
  });

  it("row 9 — a multi-word query where one word is typo'd is a GUESS, not a partial match", () => {
    // `glaze` is literal, `evenning` is not, so the message is not an exact hit for the query
    // the reader typed — and the tier says so rather than mixing it in with real matches.
    const res = corpus().search("glaze evenning");
    expect(res.items).toEqual([]);
    expect(ids(res.similar)).toContain("phrase");
  });

  it("row 10 — the floor is ZERO, and this file is what a change to it has to answer to", () => {
    // Read from the shared module rather than restated: the two doors and this table cannot
    // disagree about the number. If it moves, rows 1 and 4 above are the ones that go red.
    expect(SIMILAR_FLOOR).toBe(0);
  });

  it("row 11 — an empty query answers nothing in either tier", () => {
    const res = corpus().search("   ");
    expect(res.items).toEqual([]);
    expect(res.similar).toEqual([]);
    expect(res.tier).toBe("exact");
  });
});
