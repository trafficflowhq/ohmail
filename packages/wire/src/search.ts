/**
 * SEARCH, AS THE SERVER ANSWERS IT: the text search's page with its counts and facets, and the
 * address arm's page. One route serves both; which arm answered is said by the answer's shape.
 */
import type { MessageDTO } from "./mail.js";

/** The two tiers an answer can be: literal matches, or typo guesses. An answer is one or the other, never a mixture. */
export type SearchTier = "exact" | "similar";

/** Which side of a letter an address search looks at. */
export type AddressSearchDirection = "any" | "from" | "to";

export interface SearchResult {
  items: MessageDTO[];
  /**
   * `null` when only the page was asked for (`parts: "page"`), and on a summary past its cap: the
   * estimate's, over the page's candidates, stand. Over the candidates for `estimate`.
   */
  facets: Facets | null;
  /** How many messages match, over the tier being returned — never over both tiers. */
  total: number;
  /** WHICH TIER THIS ANSWER IS: `exact` literal matches, or `similar` typo guesses. Never mixed. */
  tier: SearchTier;
  /**
   * `false` when `total` is a lower bound: an arm was cut, or the summary passed its cap. Then the
   * facets, when present, count only the page's candidates. No count is ever read from planner
   * statistics: they cover every account's mail.
   */
  totalExact: boolean;
  /** This answer's server time in milliseconds. */
  ms: number;
  /** The next page's cursor, or `null` on the last page (always `null` for `summary`). */
  nextCursor: string | null;
  /**
   * On the last RELEVANCE page: an arm was cut at its top-K, so matches exist past the fused set
   * and the date orders walk them all.
   */
  bounded: boolean;
  /** Present on a summary while this account's search documents are still being built. */
  indexed?: { done: number; total: number };
  /** Present on every part while the store has not taken in the whole mailbox ({@link importOpen}). */
  importing?: true;
}

export interface Facets {
  /** desiredFolder (else native locator, else INBOX) → count. */
  folder: Record<string, number>;
  /** top-N senders by count within the match set. */
  sender: Array<{ address: string; count: number }>;
  unread: { true: number; false: number };
  hasAttachments: { true: number; false: number };
  /** coarse recency buckets. */
  date: { today: number; last7: number; last30: number; older: number };
}

export interface AddressSearchResult {
  /** Newest first — `SQL_RANK_ORDER`'s key sequence with the relevance term removed. */
  items: MessageDTO[];
  /** How many messages match, over the whole archive rather than over this page. */
  total: number;
  /** `false` past {@link ADDRESS_EXACT_CAP}: `total` is then a lower bound. Absent: exact. */
  totalExact?: false;
  /**
   * WHICH DIRECTION THIS ANSWER IS ABOUT — on the wire rather than inferred: a client that fell
   * back to `from` against an older server labels its rows by this field, not by what it asked.
   */
  direction: AddressSearchDirection;
  /** Present while the store has not taken in the whole mailbox ({@link importOpen}): `total` is of the mail synced so far. */
  importing?: true;
}
