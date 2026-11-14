/** SEARCH'S NUMBERS AND SHAPES: how long typed text waits, how long a pass may stand, and the two typed shapes it reads. */
import { STORE_ANSWER_TIMEOUT_MS } from "@ohmail/client-engine";

/** The orders the store answers in, in the order a person is offered them. */
export { SERVER_SEARCH_SORTS as SEARCH_SORTS } from "@ohmail/client-engine";

/**
 * One archive request per SETTLED query: a key inside the wait restarts it. 100 ms, so the page
 * fits the 250 ms budget to the rendered list; a pause longer than that between keys costs the
 * store one page, its count and facets held (`STORE_SEARCH_FOLLOWUP_HOLD_MS`).
 *
 * `GET /search` is `cost: "read"`, but cost is about volume: a request per keystroke would be ~7
 * RRF queries for "invoice". The local pass covers the typing; this covers the question.
 */
export const ARCHIVE_DEBOUNCE_MS = 100;

/**
 * How long "Searching your whole mailbox…" may stand — the ceiling on the `searching` state.
 * Reported: the sentence never resolved — `searching` was a state only a SETTLED promise could
 * replace, and `searchServer` never rejects, which is no shape at all for a request that does not
 * come back (a dropped connection, a sleeping device). Fifteen seconds: several times the slowest
 * honest `GET /search`, short enough that the person still has the question in mind. A LATE answer
 * still wins — the timer replaces the sentence, it does not cancel the request: the sentence is
 * about this request, not the session.
 */
export const ARCHIVE_TIMEOUT_MS = STORE_ANSWER_TIMEOUT_MS;

/** How near the end of the list (px) the next store page is asked for. */
export const PAGE_AHEAD_PX = 480;

/** One address and nothing else — the query shape whose empty state may offer the address door. */
export const ADDRESS_QUERY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A `from:` or `in:` scope typed into the field. */
export const OPERATOR_WORD = /(^|\s)(from|in):\S/i;
