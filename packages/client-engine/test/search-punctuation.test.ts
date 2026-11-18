import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { SearchIndex } from "../src/search.js";

/**
 * PUNCTUATION IS PART OF THE WORD — the `D-U-N-S` miss, and the two rules that answer it.
 *
 * Reported: typing `D-U-N-S` into search answered *"Nothing on this device."* while
 * an opened message's SUBJECT reads "Your D-U-N-S Number is enclosed." Nothing was broken about
 * the index or the request; the query simply did not survive tokenization. `tokenize` was
 * `text.toLowerCase().match(/[\p{L}\p{N}]+/gu)` with a two-character floor, so
 *
 *   ·  the QUERY `D-U-N-S` became `["d","u","n","s"]` and then `[]` — every part is one letter —
 *      and `search` returns the empty answer for a query with no tokens, and
 *   ·  the SUBJECT lost the same four letters, so even a phrase pass could not have found it.
 *
 * Two rules, and they are separable — each has a case here that the other cannot cover:
 *
 *  1. A hyphenated or dotted COMPOUND indexes as the compound verbatim (`d-u-n-s`) and its parts,
 *     as the stores do. The query tokenizes identically. The joined spelling `DUNS` reaches only
 *     a message that spells it so: the stores have no joined lexeme, and this is their first paint.
 *  2. A query that tokenizes to NOTHING is matched verbatim, case-insensitively, over subject
 *     and sender. `x` and `#4` are questions; answering them with silence is not.
 *
 * The residual boundary is asserted rather than left to be discovered — see the last case.
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
  updatedAt: "2026-09-08T12:00:00.000Z",
} satisfies Partial<EngineMessage>;

function msg(o: { id: string; subject: string; from?: string; snippet?: string }): EngineMessage {
  return {
    ...BASE,
    id: o.id,
    subject: o.subject,
    from: { name: null, address: o.from ?? "someone@mail.test" },
    snippet: o.snippet ?? "",
    date: "2026-09-01T09:00:00.000Z",
  };
}

/** The reported message, verbatim, plus the rows each rule needs to be told apart. */
const DUNS_SUBJECT = "Your D-U-N-S Number is enclosed.";

function corpus(): SearchIndex {
  const idx = new SearchIndex();
  for (const m of [
    msg({ id: "duns", subject: DUNS_SUBJECT, from: "registry@dnb.test" }),
    // The joined spelling, as its own message: the one row `DUNS` may reach, so an answer that
    // also holds the hyphenated rows is the joined form indexed again.
    msg({ id: "joined", subject: "DUNS lookup service" }),
    // A single letter is a question. No other subject and no sender in this corpus carries an
    // `x` — the first version of this fixture used `@example.test` senders and every row
    // matched, which is a fixture that cannot see the field it was added to test.
    msg({ id: "xray", subject: "Xylem delivery note" }),
    // `#4` — the number is under the two-character floor, so this row is reachable only
    // verbatim. `#42` beside it is NOT: `42` clears the floor and was always a token.
    msg({ id: "order4", subject: "Order #4 shipped" }),
    msg({ id: "order42", subject: "Order #42 shipped" }),
    // The pair that tells the COMPOUND rule apart from the verbatim fallback beside it — see
    // the multi-word case below. They differ only in whether the compound is there.
    msg({ id: "renewDuns", subject: "Order D-U-N-S renewal" }),
    msg({ id: "renewPlain", subject: "Order renewal notice" }),
  ]) {
    idx.add(m);
  }
  return idx;
}

const ids = (hits: { message: EngineMessage }[]): string[] => hits.map((h) => h.message.id);

describe("search over punctuation — the D-U-N-S miss", () => {
  it("`D-U-N-S` finds the message whose subject holds it", () => {
    const res = corpus().search("D-U-N-S");
    expect(res.tier).toBe("exact");
    // Both rows whose subject carries the hyphenated form, and nothing else.
    expect(ids(res.items).sort()).toEqual(["duns", "renewDuns"]);
    // The compound is matched as a WORD, not as four letters that happen to be adjacent: the
    // match the view highlights is the compound itself, which is why it can be found in the
    // subject string at all.
    expect(res.items[0]!.matches.some((m) => m.term === "d-u-n-s" && !m.fuzzy)).toBe(true);
  });

  it("the lowercase spelling is the same question", () => {
    expect(ids(corpus().search("d-u-n-s").items).sort()).toEqual(["duns", "renewDuns"]);
  });

  it("`DUNS` finds the message that spells it so, never the hyphenated ones (the store has no joined lexeme)", () => {
    const res = corpus().search("DUNS");
    expect(res.tier).toBe("exact");
    // Emit the joined form again and the two hyphenated rows join this answer.
    expect(ids(res.items).sort()).toEqual(["joined"]);
  });

  it("a single-character query is answered verbatim, not with silence", () => {
    const res = corpus().search("x");
    expect(res.tier).toBe("exact");
    expect(ids(res.items)).toEqual(["xray"]);
  });

  it("`#4` finds the orders it names, and `#42` narrows to one", () => {
    // `#4` tokenizes to nothing — `4` is under the floor — so it reaches its messages only
    // through the verbatim arm, and it reaches BOTH: `#4` is a substring of "Order #42
    // shipped" too, which is what a verbatim substring match means and is the honest answer to
    // the characters typed.
    expect(ids(corpus().search("#4").items).sort()).toEqual(["order4", "order42"]);
    // `#42` has always tokenized to `42`; it is here as the positive control that the ordinary
    // token path is untouched, and it must not become a verbatim-only case.
    expect(ids(corpus().search("#42").items)).toEqual(["order42"]);
  });

  it("a compound INSIDE a multi-word query narrows it — the fallback cannot do this", () => {
    /*
     * THE CASE THAT TELLS THE TWO RULES APART, and it was added because a mutation showed they
     * could not be: reverting `tokenize` to its one-line form left `D-U-N-S` GREEN, because that
     * query tokenizes to nothing and the verbatim fallback then answers it. Two mechanisms, one
     * assertion, and the assertion measured the pair.
     *
     * `D-U-N-S order` HAS a token, so the fallback is structurally out of reach — and the
     * compound has to participate in the AND for the answer to be the one row that carries both.
     * Without the compound rule the query is just `order` and both renewal rows come back.
     */
    expect(ids(corpus().search("D-U-N-S order").items)).toEqual(["renewDuns"]);
    // The control on the other side: `order` alone is exactly that wider question.
    expect(ids(corpus().search("order renewal").items).sort()).toEqual(["renewDuns", "renewPlain"]);
  });

  it("the sender is searched verbatim too", () => {
    // `y@d` straddles the `@`: both sides are single characters, so it tokenizes to nothing and
    // is reachable only verbatim — and the string it names is in the ADDRESS, not the subject.
    expect(ids(corpus().search("y@d").items)).toEqual(["duns"]);
    // The control beside it: `dnb` clears the two-character floor and was always an ordinary
    // token, so the verbatim arm must not be what answers it.
    expect(ids(corpus().search("dnb").items)).toEqual(["duns"]);
  });

  it("a query that names nothing still answers nothing", () => {
    // The verbatim arm is an arm, not a floor: it must not turn every short query into a hit.
    expect(corpus().search("q").items).toEqual([]);
    expect(corpus().search("§").items).toEqual([]);
    expect(corpus().search("   ").items).toEqual([]);
  });

  it("ordinary words are tokenized exactly as before", () => {
    // The compound pass adds tokens; it must not take any away, and a text with no compound in
    // it must produce the same tokens it always did (score doubling on a repeated query token
    // included — `intersect` sums per token).
    const res = corpus().search("order shipped");
    expect(ids(res.items).sort()).toEqual(["order4", "order42"]);
  });

  /**
   * THE BOUNDARY, ASSERTED SO IT IS NOT DISCOVERED.
   *
   * The query tokenizes exactly as the subject does, and `search` ANDs across a query's tokens.
   * So `D-U-N-S` — two tokens, `d-u-n-s` and `duns` — asks for both, and a message whose subject
   * only ever says `DUNS` carries just the second one. The hyphenated query is therefore the
   * MORE SPECIFIC of the two, and the joined query is the one that reaches both spellings.
   *
   * That asymmetry is a consequence of "the query tokenizes identically", which is the decided
   * rule. It is written down here because a reader who types the hyphenated form and misses a
   * joined-spelling message has met a boundary, not a bug — and if that boundary is ever judged
   * wrong, this is the case that has to change first.
   */
  it("the hyphenated query is the more specific one, and says so", () => {
    expect(ids(corpus().search("D-U-N-S").items)).not.toContain("joined");
  });
});
