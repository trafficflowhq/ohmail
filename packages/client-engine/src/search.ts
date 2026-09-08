import {
  compareRanked,
  compoundForms,
  type RankedRow,
  MIN_FUZZY_QUERY_LEN,
  MIN_FUZZY_TERM_LEN,
  showSimilar,
  type RankedRow,
  type SearchTier,
} from "@trafficflow/core/search-rank";
import type { EntityReader } from "./store.js";
import { folderLeaf, isProtectedMessage, VIEW_OF_FOLDER, type EngineMessage, type MessageBodyRecord } from "./types.js";

/**
 * The instant local search over the mirror (brief §1: "the client should ALSO run instant
 * local search over its mirror"). Lexical tokens over subject / from / snippet / whatever
 * body text this device actually holds, with field weighting, plus a padded-trigram fuzzy
 * arm (pg_trgm-style) so the canonical 'invoce' → "Invoice" typo case matches.
 *
 * ── THE TYPO ARM IS A SEPARATE ANSWER, NOT A CONTRIBUTION TO THIS ONE ────────────────────
 *
 * It used to be one pool: exact, prefix and fuzzy matches all accumulated into a single score
 * and the list was whatever that score ordered. Scoring is `field weight × match quality`, so
 * a subject-weighted GUESS routinely outscored a body-weighted CERTAINTY — measured on the demo
 * corpus, the query `graphite` put "Fotos vom Grat" (trigram similarity 0.43 against a subject,
 * ×3) above the message whose body says `graphite` (an exact match, ×1). The reader's own word,
 * present verbatim, ranked second to a word they did not type.
 *
 * So the arms are now TIERS, and the rule lives in `@trafficflow/core/search-rank` because the
 * hosted door has to apply the same one. Exact and prefix matches are the answer; the fuzzy arm
 * runs only when that answer is empty, and its hits come back in `similar` — a separate array,
 * so no caller can interleave them by accident. See {@link LocalSearchResult}.
 *
 * ── WHAT THIS INDEX CAN SEE, AND THE TWO SENTENCES THAT USED TO BE HERE ──────────────────
 *
 * This header used to say it indexed "subject/from/snippet/body" and that "`/search` remains
 * the full-corpus fallback". Both were false, and together they are why a live account was
 * told its local results were complete:
 *
 *  · **`body` is a fixtures-only extra.** It is declared on `EngineMessageExtras` in
 *    `types.ts`; the wire `MessageDTO` carries `snippet` and has no body field at all, so on a
 *    Cloud account `m.body` is `undefined` for every row. `snippet` is what the ingest pipeline
 *    derives — the body, whitespace-collapsed and truncated to 200 characters.
 *  · **`/search` was not a fallback.** It was mounted, spend-classed `read`, RRF-ranked and
 *    contract-tested, with ZERO callers on any surface. Nothing had ever asked it anything.
 *
 * The gap is structural rather than marginal. A snippet is capped at 200 characters by the
 * ingest pipeline and a mail body is routinely many times longer, so most of the text this
 * client is asked to search is simply not on the device — and a message whose snippet came
 * out empty contributes nothing at all.
 *
 * So the index reports {@link SearchCoverage} with every result, and the UI states it. A
 * surface that renders these hits without saying what was searched is making the same claim
 * the toast used to make in words.
 *
 * ── HOW COVERAGE GROWS ───────────────────────────────────────────────────────────────────
 *
 * Hydrated bodies ARE indexed: opening a message stores `GET /messages/:id/body` in a
 * client-local `message_body` record, and {@link SearchIndex.build} reads them. So a message the user has
 * opened becomes fully searchable on this device, permanently, without a second request. That
 * is a real widening and it is still not the corpus — reading a message is how a body gets
 * here, and nobody has read a whole mailbox. The rest is what `OhmailEngine.searchServer` is
 * for.
 */

export interface SearchMatch {
  /** The query token. */
  token: string;
  /** The indexed term it matched. */
  term: string;
  fuzzy: boolean;
}

export interface SearchHit {
  message: EngineMessage;
  score: number;
  matches: SearchMatch[];
}

/**
 * WHICH SIDE OF A MESSAGE AN ADDRESS APPEARED ON — the address view's toggle, as a type.
 *
 * `"from"` is mail that address WROTE (it is the message's `From`); `"to"` is mail sent TO it
 * (it is in the message's `To` or `Cc`); `"any"` is both, which is the view's default and the
 * only one of the three that is a UNION rather than a filter.
 *
 * `Cc` counts as `"to"` and is deliberately not its own member. The question the view asks is
 * "did this mail go to them", and a person copied on a message received it; splitting the two
 * would put a distinction on screen that nobody reading their own mail is looking for.
 */
export type AddressDirection = "any" | "from" | "to";

/**
 * HOW MUCH MAIL THIS DEVICE HOLDS FOR ONE ADDRESS, PER DIRECTION.
 *
 * **`any` is the UNION and never `from + to`**, and the difference is a real message rather than
 * an edge case: a self-CC, a mailing-list echo of your own post, and any message where somebody
 * both wrote and was copied all sit on BOTH sides. Adding the two would count those twice and
 * the toggle would say "All 12" over a list of eleven rows — a number a reader can disprove by
 * counting, which is the worst kind of wrong number.
 *
 * So `any <= from + to`, with equality exactly when no message is on both sides.
 */
export interface AddressCounts {
  /** Messages where the address is on EITHER side — each counted once. */
  any: number;
  /** Messages the address SENT (its `From`). */
  from: number;
  /** Messages sent TO the address (its `To` or `Cc`). */
  to: number;
}

/**
 * WHAT THIS DEVICE CAN ANSWER ABOUT ONE ADDRESS — see {@link SearchIndex.messagesWith}.
 *
 * `items` reuses {@link SearchHit} so a surface renders an address result with the same row it
 * renders a search result with. **The `score` on every hit is `0` and `matches` is empty, and
 * both are honest rather than lazy:** an address query is an EQUALITY, so there is no relevance
 * dimension to report and nothing "matched a token". The order is the array's own — newest
 * first — and a caller that re-sorts by `score` gets one arbitrary order for every row.
 */
export interface AddressResult {
  items: SearchHit[];
  counts: AddressCounts;
}

/**
 * THE ADDRESS EQUALITY, IN ONE PLACE — `lower()`, and deliberately NOT `trim()`.
 *
 * It is the rule three other places in this tree already apply to the same question, and it is
 * theirs rather than a fourth opinion:
 *
 *  · `messages_account_from_addr_idx` is `(account_id, lower(from_address), id)`
 *    (`packages/db/src/schema-mail.ts`), so the server's index folds case and nothing else;
 *  · `SearchService`'s own sender filter is `lower(m.from_address) = lower($1)`
 *    (`packages/services/src/search-service.ts`) — no trim on either side;
 *  · `address-book.ts` keys its entries `raw.toLowerCase()`, also without a trim.
 *
 * A trim here would make the DEVICE answer a wider question than the archive, so a message
 * would appear on one side of the same view and not the other with nothing to say why. And
 * `apps/webapp/app/shell/address-key.ts` sets out the general form of the argument at length
 * for the mailbox-row version of this key: **a grouping may be narrower than the constraint it
 * mirrors; it may never be wider.** Trimming is wider.
 */
export function addressMatchKey(address: string): string {
  return address.toLowerCase();
}

export interface SearchFacets {
  /** Counts per client view (ohbox/reads/receipts/…). */
  folder: Record<string, number>;
  sender: Array<{ address: string; name: string | null; count: number }>;
  hasAttachment: { true: number; false: number };
  unread: { true: number; false: number };
}

/**
 * WHAT THE LOCAL INDEX WAS ABLE TO READ — reported with every result, because a surface
 * that shows these hits is implicitly making a claim about the corpus.
 *
 * `full` counts messages whose whole text is on this device: a fixture row's own `body`, or a
 * `message_body` record that opening the message hydrated. Everything else contributed its subject, its
 * sender and at most 200 characters of preview. On the demo `full === messages`; on a live
 * account it starts at 0 and grows by one every time somebody opens a message.
 */
export interface SearchCoverage {
  /** Messages in the mirror when this index was built. */
  messages: number;
  /** …of which the FULL text was indexable. Never greater than `messages`. */
  full: number;
}

export interface LocalSearchResult {
  /**
   * THE EXACT TIER — every token matched literally (an exact term or a prefix of one). This is
   * the answer, and a hit here never carries a fuzzy match.
   *
   * The field keeps its name and its meaning narrows, which is deliberate: a caller that reads
   * only `items` and ignores `similar` gets a strictly better list than it used to, never a
   * mixed one. There is no way to opt into the old interleaving by forgetting a field.
   */
  items: SearchHit[];
  /**
   * THE SIMILAR TIER — hits at least one of whose tokens only matched through typo tolerance.
   *
   * **Non-empty only when `items` is empty** (`showSimilar`, and the argument for the floor is
   * in `@trafficflow/core/search-rank`). A surface renders these under their own heading and
   * below the exact ones; because of the rule, "below the exact ones" is always "below none".
   */
  similar: SearchHit[];
  /** Which tier `items ++ similar` came from — `similar` exactly when `items` is empty. */
  tier: SearchTier;
  facets: SearchFacets;
  /** What this answer is an answer OVER. See {@link SearchCoverage}. */
  coverage: SearchCoverage;
}

/**
 * Field weights. Subject over sender over body text — a term in the subject line is a stronger
 * statement about what a message is about than the same term buried in its body.
 *
 * These now only ever compare LIKE WITH LIKE. Before the tiers they also decided exact-versus-
 * guess contests, which is the comparison they are useless for: `3 × 0.43` beat `1 × 1.0` and
 * put a trigram guess above the reader's own word.
 */
const FIELD_WEIGHT = { subject: 3, from: 2, text: 1 } as const;
const FUZZY_THRESHOLD = 0.4;

/**
 * MULTI-WORD QUERIES PREFER THE PHRASE — the bonus a hit earns when the words the reader typed
 * appear together, in that order, rather than merely all appearing somewhere.
 *
 * Applied to the subject and the sender only, and that limit is a memory decision rather than a
 * judgement about bodies: those two strings are already on the `EngineMessage` this index holds
 * a reference to, so checking them costs nothing per message. Holding every hydrated body as a
 * searchable string beside the postings would double the index's footprint on a large mirror
 * for a signal that matters most in exactly the field it is cheapest in — a subject line is a
 * phrase, a body is prose.
 *
 * Additive on top of the token scores rather than a multiplier, so a phrase hit is a promotion
 * within the exact tier and never a way out of it.
 */
const PHRASE_BONUS = { subject: 2, from: 1 } as const;

/**
 * TEXT → TERMS, and a hyphenated compound is THREE of them.
 *
 * The ordinary word pass is unchanged and still decides the floor: runs of letters and digits,
 * two characters or more. What is added is `compoundForms` — the shared rule in
 * `@trafficflow/core/search-rank`, which the SQL door's verbatim arm is gated by the other half
 * of — so `Your D-U-N-S Number` indexes `d-u-n-s` and `duns` beside `your` and `number`.
 *
 * ── ONE FUNCTION, BOTH SIDES, AND THAT IS THE WHOLE FIX ────────────────────────────────────
 *
 * The query goes through this same function, so `D-U-N-S` becomes `["d-u-n-s", "duns"]` and the
 * subject carries both; `DUNS` becomes `["duns"]` and reaches the same message through the
 * joined form. The consequence worth naming, because a reader can meet it: `search` ANDs across
 * a query's tokens, so the hyphenated query is the MORE SPECIFIC of the two — it asks for the
 * compound as well, and a subject that only ever says `DUNS` does not carry it.
 * `search-punctuation.test.ts` asserts that boundary rather than leaving it to be discovered.
 *
 * Compounds come FIRST so that `matches[0]` is the compound rather than its joined form: the
 * view highlights a match by finding its term inside the subject, and only the compound is
 * actually in the subject string.
 *
 * A text with no compound in it produces the array it always did, term for term — including
 * repeats, which `intersect` sums, so the identity case is genuinely identical.
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const words = (lower.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2);
  const forms = compoundForms(lower);
  if (forms.length === 0) return words;
  const seen = new Set(words);
  const extra = forms.filter((f) => !seen.has(f));
  return extra.length === 0 ? words : [...extra, ...words];
}

/** pg_trgm-style padded trigrams: "  t", " te", "ter", …, "rm " */
function trigrams(term: string): Set<string> {
  const padded = `  ${term} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function diceSimilarity(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return (2 * common) / (a.size + b.size);
}

interface Posting {
  weight: number;
}

/** Which sides of ONE message ONE address sat on. Both can be true — see {@link AddressCounts}. */
interface AddressSides {
  from: boolean;
  to: boolean;
}

export class SearchIndex {
  /** term → messageId → best field weight */
  private readonly postings = new Map<string, Map<string, Posting>>();
  /**
   * EXACT ADDRESS → messageId → which sides — a SEPARATE map from {@link postings}, and the
   * separation is the whole feature.
   *
   * {@link tokenize} splits on every non-alphanumeric character, so `anna@corp.com` enters
   * `postings` as the three unrelated terms `anna`, `corp`, `com` — and `com` is a term that
   * every address on the internet shares. There is therefore no way to ask `postings` for one
   * ADDRESS: the query `anna@corp.com` matches `anna@other.com` and `bob@corp.com` on two of its
   * three tokens each, and a prefix arm widens it further. That is right for searching and
   * useless for identity.
   *
   * So an address is stored WHOLE and lowercased, and the only operation on this map is a map
   * lookup — no prefix arm, no trigrams, no scoring. It costs one entry per distinct address per
   * message, which is bounded by the recipients a message actually names.
   */
  private readonly addresses = new Map<string, Map<string, AddressSides>>();
  private readonly trigramCache = new Map<string, Set<string>>();
  private readonly messages = new Map<string, EngineMessage>();
  private full = 0;

  /**
   * Build over the mirror — messages AND the bodies that have been hydrated.
   *
   * The `message_body` pass is what makes `add`'s second argument worth having. Reading the
   * records into a map first is not an optimisation: `reader.list` is O(n) per call, and
   * looking one up per message would be O(n²) on a mirror of any real size, on every keystroke.
   */
  static build(reader: EntityReader): SearchIndex {
    const idx = new SearchIndex();
    const bodies = new Map<string, string>();
    for (const b of reader.list<MessageBodyRecord>("message_body")) {
      // Only `ready` is text. `loading` and `failed` records carry `text: ""` and indexing
      // them would count a message as covered because we ASKED for its body, not because we
      // have it — which is exactly the shape of claim this gap is about.
      if (b.state === "ready") bodies.set(b.messageId, b.text);
    }
    for (const m of reader.list<EngineMessage>("message")) idx.add(m, bodies.get(m.id));
    return idx;
  }

  /** What this index was able to read. Reported with every result — see {@link SearchCoverage}. */
  coverage(): SearchCoverage {
    return { messages: this.messages.size, full: this.full };
  }

  private index(term: string, messageId: string, weight: number): void {
    let map = this.postings.get(term);
    if (!map) {
      map = new Map();
      this.postings.set(term, map);
      this.trigramCache.set(term, trigrams(term));
    }
    const existing = map.get(messageId);
    if (!existing || existing.weight < weight) map.set(messageId, { weight });
  }

  /**
   * Record that ONE address sat on ONE side of ONE message. Idempotent per side, and a second
   * call for the other side keeps the first: a self-CC is `from` AND `to`, not the later of the
   * two.
   *
   * An empty address is dropped rather than stored under the key `""`. A `From` header can
   * genuinely be blank (`messages.from_address` is `NOT NULL DEFAULT ''` on the server), and a
   * bucket under the empty key would collect every such message and then answer them all to a
   * caller whose address happened to normalize to nothing.
   */
  private indexAddress(address: string, messageId: string, side: "from" | "to"): void {
    const key = addressMatchKey(address);
    if (key === "") return;
    let byMessage = this.addresses.get(key);
    if (!byMessage) {
      byMessage = new Map();
      this.addresses.set(key, byMessage);
    }
    const sides = byMessage.get(messageId);
    if (sides) sides[side] = true;
    else byMessage.set(messageId, { from: side === "from", to: side === "to" });
  }

  /**
   * EVERY MESSAGE ON THIS DEVICE INVOLVING ONE ADDRESS, newest first, with the counts for all
   * three directions — the address view's whole device half.
   *
   * ── THE COUNTS ARE ALWAYS ALL THREE, WHATEVER `direction` ASKS FOR ─────────────────────
   *
   * `items` is filtered by `direction`; `counts` is not, and that asymmetry is deliberate. The
   * toggle has to be able to say "All 12 · From them 9 · To them 4" while showing one of the
   * three, and a caller that had to call three times to fill in its own control would either
   * walk the postings three times or (far more likely) label the two it did not ask for with the
   * number it did.
   *
   * ── ORDER: NEWEST FIRST, BY {@link compareRanked} WITH AN EQUAL SCORE ──────────────────
   *
   * Not a private date comparator. With every `score` equal, `compareRanked` degrades exactly to
   * `date desc, nulls last, id` — which IS newest-first, with the undated-sorts-last rule and
   * the stable `id` tail that keep a list from reshuffling itself between renders. Writing a
   * second comparator here would be a second place for those two rules to be got wrong.
   */
  messagesWith(address: string, direction: AddressDirection = "any"): AddressResult {
    const key = addressMatchKey(address);
    const byMessage = key === "" ? undefined : this.addresses.get(key);
    if (byMessage === undefined) return { items: [], counts: { any: 0, from: 0, to: 0 } };

    const counts: AddressCounts = { any: 0, from: 0, to: 0 };
    const rows: Array<{ hit: SearchHit; row: RankedRow }> = [];
    for (const [id, sides] of byMessage) {
      const message = this.messages.get(id);
      // A posting with no message would be a torn index. `add` writes both from one call, so
      // this cannot happen — and it is skipped rather than asserted because the alternative is
      // throwing out of a keystroke-path selector on a mirror we could still answer from.
      if (message === undefined) continue;
      counts.any++;
      if (sides.from) counts.from++;
      if (sides.to) counts.to++;
      const wanted = direction === "any"
        || (direction === "from" && sides.from)
        || (direction === "to" && sides.to);
      if (!wanted) continue;
      rows.push({
        // score 0 and no matches — an equality has no relevance. See {@link AddressResult}.
        hit: { message, score: 0, matches: [] },
        row: { score: 0, dateMs: stampOf(message), id: message.id },
      });
    }
    rows.sort((a, b) => compareRanked(a.row, b.row));
    return { items: rows.map((r) => r.hit), counts };
  }

  /**
   * `hydrated` is the `message_body` record's text when this device has one. `m.body` is the
   * fixture world's own field and is `undefined` on every Cloud row — the two are separate
   * arguments rather than one because `types.ts` keeps them in separate records deliberately:
   * a `mark_seen` echo replaces the message entity and would wipe a body written onto it.
   */
  add(m: EngineMessage, hydrated?: string): void {
    this.messages.set(m.id, m);
    // Every message's full body is indexed — bodies are no longer withheld from the reader, so a
    // search over the reader's own mailbox reaches all of it, sensitive mail included.
    // ({@link isProtectedMessage} is a constant `false` now; it is left in the expression as the
    // one named seam should that policy ever change again.)
    const whole = isProtectedMessage(m) ? undefined : (m.body ?? hydrated);
    if (whole !== undefined) this.full++;
    for (const t of tokenize(m.subject)) this.index(t, m.id, FIELD_WEIGHT.subject);
    for (const t of tokenize(`${m.from.name ?? ""} ${m.from.address}`)) this.index(t, m.id, FIELD_WEIGHT.from);
    // THE EXACT ADDRESSES, on top of the tokens above — see {@link SearchIndex.addresses}.
    // `?? []` on the recipients and not on `from`: the mirror is persisted on the device and a
    // row written by a build that predates `to`/`cc` genuinely has neither, exactly as
    // `address-book.ts` guards them; `from` has been on the DTO since the first message row.
    this.indexAddress(m.from.address, m.id, "from");
    for (const who of m.to ?? []) this.indexAddress(who.address, m.id, "to");
    for (const who of m.cc ?? []) this.indexAddress(who.address, m.id, "to");
    // The snippet is indexed alongside the body: the two strings are not always prefix-related, so
    // dropping it would lose terms.
    for (const t of tokenize(`${m.snippet} ${whole ?? ""}`)) this.index(t, m.id, FIELD_WEIGHT.text);
  }

  /**
   * One query token's hits from the LITERAL arms: exact term (×1), prefix of a term (×0.7).
   *
   * The prefix arm is what makes the index answer as-you-type — "invoi" has to find the invoice
   * before the reader has finished the word — and it is counted as literal rather than as a
   * guess because the reader's characters are all present, in order, at the start of the term.
   */
  private literalHits(q: string): Map<string, { score: number; match: SearchMatch }> {
    const hits = new Map<string, { score: number; match: SearchMatch }>();
    const exact = this.postings.get(q);
    if (exact) {
      for (const [id, p] of exact) {
        hits.set(id, { score: p.weight, match: { token: q, term: q, fuzzy: false } });
      }
    }
    for (const [term, map] of this.postings) {
      if (term === q || !term.startsWith(q)) continue;
      for (const [id, p] of map) {
        const score = p.weight * 0.7;
        const prev = hits.get(id);
        if (!prev || prev.score < score) hits.set(id, { score, match: { token: q, term, fuzzy: false } });
      }
    }
    return hits;
  }

  /**
   * One query token's hits WITH typo tolerance — the literal arms plus the padded-trigram arm.
   *
   * Two length floors, and they bound different strings. The QUERY token must be long enough to
   * be worth guessing about at all; the INDEXED TERM must be long enough that a guess against it
   * means something. The second one did not exist, and its absence was the loudest half of the
   * complaint this tier model answers: on the demo corpus `invoce` matched the two-letter word
   * `in` at a similarity over the threshold and dragged nineteen unrelated messages into a
   * one-answer query, and `anna` reached twelve of them through `and`. Both floors live in
   * `@trafficflow/core/search-rank` so the hosted door can be held to the same shape.
   */
  private fuzzyHits(q: string): Map<string, { score: number; match: SearchMatch }> {
    const hits = this.literalHits(q);
    if (q.length < MIN_FUZZY_QUERY_LEN) return hits;
    const qTri = trigrams(q);
    for (const [term, map] of this.postings) {
      if (term === q || term.startsWith(q)) continue;
      if (term.length < MIN_FUZZY_TERM_LEN) continue;
      const sim = diceSimilarity(qTri, this.trigramCache.get(term)!);
      if (sim < FUZZY_THRESHOLD) continue;
      for (const [id, p] of map) {
        const score = p.weight * sim;
        const prev = hits.get(id);
        if (!prev || prev.score < score) hits.set(id, { score, match: { token: q, term, fuzzy: true } });
      }
    }
    return hits;
  }

  /** AND across the query's tokens: a message must answer every one of them. */
  private intersect(
    qTokens: string[],
    arm: (q: string) => Map<string, { score: number; match: SearchMatch }>,
  ): Map<string, { score: number; matches: SearchMatch[] }> {
    let candidates: Map<string, { score: number; matches: SearchMatch[] }> | null = null;
    for (const q of qTokens) {
      const tokenHits = arm(q);
      if (candidates === null) {
        candidates = new Map();
        for (const [id, hit] of tokenHits) candidates.set(id, { score: hit.score, matches: [hit.match] });
      } else {
        const next = new Map<string, { score: number; matches: SearchMatch[] }>();
        for (const [id, acc] of candidates) {
          const hit = tokenHits.get(id);
          if (hit) next.set(id, { score: acc.score + hit.score, matches: [...acc.matches, hit.match] });
        }
        candidates = next;
      }
      if (candidates.size === 0) break;
    }
    return candidates ?? new Map();
  }

  /** Score → hit, phrase bonus applied, ordered by {@link compareRanked}, then cut to `limit`. */
  private rank(
    candidates: Map<string, { score: number; matches: SearchMatch[] }>,
    phrase: string | null,
    limit: number,
  ): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const [id, acc] of candidates) {
      const message = this.messages.get(id)!;
      let score = acc.score;
      if (phrase !== null) {
        if (phraseField(message.subject).includes(phrase)) score += PHRASE_BONUS.subject;
        else if (phraseField(`${message.from.name ?? ""} ${message.from.address}`).includes(phrase)) {
          score += PHRASE_BONUS.from;
        }
      }
      hits.push({ message, score, matches: acc.matches });
    }
    hits.sort((a, b) =>
      compareRanked(
        { score: a.score, dateMs: stampOf(a.message), id: a.message.id },
        { score: b.score, dateMs: stampOf(b.message), id: b.message.id },
      ),
    );
    return hits.slice(0, limit);
  }

  /**
   * A QUERY THAT TOKENIZES TO NOTHING IS STILL A QUESTION — matched verbatim over subject and
   * sender, case-insensitively.
   *
   * This used to return the empty answer, which is the shape the `D-U-N-S` report arrived as:
   * silence that is indistinguishable from an empty mailbox. `x`, `#4` and `y@d` all name
   * something; a two-character floor is a sensible rule for TERMS and a wrong answer to a
   * person who typed one character on purpose.
   *
   * ── WHY A SCAN IS ACCEPTABLE HERE AND NOWHERE ELSE ──────────────────────────────────────
   *
   * It walks every message, which is exactly what the postings map exists to avoid — and it is
   * reached only by a query the postings map cannot answer at all: one whose every run of
   * letters and digits is a single character. Two strings per message, `includes` on each. That
   * is the first keystroke of an ordinary query (`i` of `invoice`) and nothing else, and
   * `search-budget.test.ts` measures it on a synthetic twenty-thousand-row index so the claim is
   * a number. (Spelled out, not written as digits: the publish prose gate reads a bare count
   * beside the word "messages" as a count of somebody's mail, which is the right rule — it
   * refused this comment, and the number here is a benchmark size, not a mailbox.)
   *
   * `tier` is `exact`: the reader's characters are present, in order, in the field. It is not a
   * guess and it does not belong under the Similar heading.
   */
  private verbatim(query: string, limit: number): LocalSearchResult {
    const needle = query.trim().toLowerCase();
    if (needle === "") {
      return { items: [], similar: [], tier: "exact", facets: emptyFacets(), coverage: this.coverage() };
    }
    const match: SearchMatch = { token: needle, term: needle, fuzzy: false };
    /*
     * ORDERED ON A PRECOMPUTED KEY, and this is not a micro-optimisation — it is what keeps the
     * scan inside a keystroke. `rank` calls `stampOf` (a `Date.parse`) on BOTH SIDES OF EVERY
     * COMPARISON, which is right and free for a token arm's handful of candidates and about
     * 285 000 parses for a single common character that matched a whole mirror: measured 25.7 ms
     * on the twenty-thousand-row benchmark index, most of it there, against 12 ms for the scan
     * and the sort themselves.
     *
     * So the date is parsed ONCE PER MESSAGE and the rows are ordered by {@link compareRanked} —
     * the shared comparator, unchanged — before the surviving page is materialised. A top-of-list
     * selection under the ordering rule, never a window ranked after the fact. There is no phrase
     * bonus to apply: a query with no tokens has no token sequence to prefer.
     */
    const rows: RankedRow[] = [];
    for (const [id, m] of this.messages) {
      // Subject over sender, the same weights the token arms use — and the subject is checked
      // first so a message matching both is scored as the stronger of the two, not the last.
      const weight = m.subject.toLowerCase().includes(needle)
        ? FIELD_WEIGHT.subject
        : `${m.from.name ?? ""} ${m.from.address}`.toLowerCase().includes(needle)
          ? FIELD_WEIGHT.from
          : 0;
      if (weight === 0) continue;
      rows.push({ score: weight, dateMs: stampOf(m), id });
    }
    rows.sort(compareRanked);
    const items: SearchHit[] = rows.slice(0, limit).map((r) => ({
      message: this.messages.get(r.id)!,
      score: r.score,
      matches: [match],
    }));
    return { items, similar: [], tier: "exact", facets: facetsOf(items), coverage: this.coverage() };
  }

  /**
   * THE ANSWER, IN TIERS. Exact and prefix matches are the result; typo tolerance is a second,
   * separately-labelled answer that exists only when the first one is empty.
   *
   * ── THE FUZZY ARM IS NOT RUN AT ALL WHEN THERE ARE EXACT HITS ───────────────────────────
   *
   * That is the rule's shape and it is also where the cost went. The literal arms are a map
   * lookup plus one pass over the term list for prefixes; the fuzzy arm computes a trigram
   * set intersection against EVERY indexed term, for every query token, on every keystroke.
   * On a large mirror that is the dominant cost of a search, and under this rule the
   * common case — a query with an answer — never pays it.
   */
  search(query: string, opts: { limit?: number } = {}): LocalSearchResult {
    const qTokens = tokenize(query);
    const limit = opts.limit ?? 50;
    if (qTokens.length === 0) return this.verbatim(query, limit);
    // A single-token query has no phrase to prefer — the token IS the phrase, and every hit
    // would earn the same bonus, which is not an ordering.
    const phrase = qTokens.length > 1 ? phraseField(query) : null;

    const exact = this.intersect(qTokens, (q) => this.literalHits(q));
    if (!showSimilar(exact.size)) {
      const items = this.rank(exact, phrase, limit);
      return { items, similar: [], tier: "exact", facets: facetsOf(items), coverage: this.coverage() };
    }

    // `exact` is empty here under today's floor; the subtraction below does not assume that, so
    // the floor can move without this quietly listing a message under both headings.
    const withFuzzy = this.intersect(qTokens, (q) => this.fuzzyHits(q));
    for (const id of exact.keys()) withFuzzy.delete(id);
    const items = this.rank(exact, phrase, limit);
    const similar = this.rank(withFuzzy, phrase, limit);
    return {
      items,
      similar,
      tier: items.length === 0 && similar.length > 0 ? "similar" : "exact",
      facets: facetsOf(items.length > 0 ? items : similar),
      coverage: this.coverage(),
    };
  }
}

/** `Date:` as millis for the tie-break, or `null` for a message that has none. */
function stampOf(m: EngineMessage): number | null {
  if (!m.date) return null;
  const t = Date.parse(m.date);
  return Number.isFinite(t) ? t : null;
}

/**
 * A field reduced to " token token token " — the same normalization {@link tokenize} applies,
 * rejoined and padded. The padding is what makes a plain `includes` a whole-token-sequence
 * test: " glaze evening " cannot match inside "unglazed evenings".
 */
function phraseField(text: string): string {
  return ` ${(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ")} `;
}

function emptyFacets(): SearchFacets {
  return { folder: {}, sender: [], hasAttachment: { true: 0, false: 0 }, unread: { true: 0, false: 0 } };
}

function facetsOf(items: SearchHit[]): SearchFacets {
  const facets = emptyFacets();
  const senders = new Map<string, { address: string; name: string | null; count: number }>();
  for (const { message: m } of items) {
    // Facet keys are view ids where a view exists, and otherwise the folder's
    // LEAF — never the raw path. Views render these keys directly, so a raw
    // path here would put a namespaced string straight on screen for any
    // folder this client has no view for.
    const view = VIEW_OF_FOLDER[m.folder] ?? folderLeaf(m.folder);
    facets.folder[view] = (facets.folder[view] ?? 0) + 1;
    const s = senders.get(m.from.address) ?? { address: m.from.address, name: m.from.name, count: 0 };
    s.count++;
    senders.set(m.from.address, s);
    facets.hasAttachment[m.hasAttachments ? "true" : "false"]++;
    facets.unread[m.unread ? "true" : "false"]++;
  }
  facets.sender = [...senders.values()].sort((a, b) => b.count - a.count);
  return facets;
}
