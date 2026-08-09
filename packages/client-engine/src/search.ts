import type { EntityReader } from "./store.js";
import { folderLeaf, isProtectedMessage, VIEW_OF_FOLDER, type EngineMessage, type MessageBodyRecord } from "./types.js";

/**
 * The instant local search over the mirror (brief §1: "the client should ALSO run instant
 * local search over its mirror"). Lexical tokens over subject / from / snippet / whatever
 * body text this device actually holds, with field weighting, plus a padded-trigram fuzzy
 * arm (pg_trgm-style) so the canonical 'invoce' → "Invoice" typo case matches.
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
  items: SearchHit[];
  facets: SearchFacets;
  /** What this answer is an answer OVER. See {@link SearchCoverage}. */
  coverage: SearchCoverage;
}

const FIELD_WEIGHT = { subject: 3, from: 2, text: 1 } as const;
const FUZZY_THRESHOLD = 0.4;
const MIN_FUZZY_LEN = 4;

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
   * AND-semantics across query tokens. Per token: exact term hit (×1), prefix
   * hit (×0.7), else trigram-fuzzy hit (×similarity) — annotated so the UI can
   * render 'fuzzy match — "invoice"'.
   */
  search(query: string, opts: { limit?: number } = {}): LocalSearchResult {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return { items: [], facets: emptyFacets(), coverage: this.coverage() };

    // messageId → accumulated { score, matches }
    let candidates: Map<string, { score: number; matches: SearchMatch[] }> | null = null;

    for (const q of qTokens) {
      const tokenHits = new Map<string, { score: number; match: SearchMatch }>();

      const exact = this.postings.get(q);
      if (exact) {
        for (const [id, p] of exact) {
          tokenHits.set(id, { score: p.weight, match: { token: q, term: q, fuzzy: false } });
        }
      }
      // Prefix arm (as-you-type).
      for (const [term, map] of this.postings) {
        if (term === q || !term.startsWith(q)) continue;
        for (const [id, p] of map) {
          const score = p.weight * 0.7;
          const prev = tokenHits.get(id);
          if (!prev || prev.score < score) {
            tokenHits.set(id, { score, match: { token: q, term, fuzzy: false } });
          }
        }
      }
      // Fuzzy arm — typo tolerance ('invoce' → invoice).
      if (q.length >= MIN_FUZZY_LEN) {
        const qTri = trigrams(q);
        for (const [term, map] of this.postings) {
          if (term === q || term.startsWith(q)) continue;
          const sim = diceSimilarity(qTri, this.trigramCache.get(term)!);
          if (sim < FUZZY_THRESHOLD) continue;
          for (const [id, p] of map) {
            const score = p.weight * sim;
            const prev = tokenHits.get(id);
            if (!prev || prev.score < score) {
              tokenHits.set(id, { score, match: { token: q, term, fuzzy: true } });
            }
          }
        }
      }

      // AND: intersect with the running candidate set.
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

    const items: SearchHit[] = [...(candidates ?? new Map())]
      .map(([id, acc]) => ({ message: this.messages.get(id)!, score: acc.score, matches: acc.matches }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 50);

    return { items, facets: facetsOf(items), coverage: this.coverage() };
  }
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
