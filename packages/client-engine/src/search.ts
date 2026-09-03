import {
  compareRanked,
  MIN_FUZZY_QUERY_LEN,
  MIN_FUZZY_TERM_LEN,
  showSimilar,
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

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2);
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

export class SearchIndex {
  /** term → messageId → best field weight */
  private readonly postings = new Map<string, Map<string, Posting>>();
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
    if (qTokens.length === 0) {
      return { items: [], similar: [], tier: "exact", facets: emptyFacets(), coverage: this.coverage() };
    }
    const limit = opts.limit ?? 50;
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
