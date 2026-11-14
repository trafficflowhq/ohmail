import type { ScreenerWaitingItemWire } from "../adapters/adapter.js";
import { senderKey } from "../selectors.js";
import type { EngineMutation, ScreenerWaitingSenderDTO } from "../types.js";
import { EAGER_BODIES_MAX } from "./options.js";

/**
 * The most body fetches in the air at once, across all messages.
 *
 * Four rather than one: a thread of a handful of messages should still fill in at roughly the
 * speed it does today, and browsers cap per-host connections in this region anyway — the point is
 * to stop a forty-message sender from opening forty at once, not to serialise reading.
 */
export const MAX_CONCURRENT_BODIES = 4;

/**
 * HOW LONG A FAILED BODY STANDS BEFORE A SURFACE SHOWING IT MAY ASK AGAIN. A failure is a state of
 * one attempt: a person looking at the message re-asks once it is older than this, and Retry asks
 * at once. The hold is what keeps an effect re-running per render from polling a refusing server;
 * the background pass never re-asks a failure within the session ({@link OhmailEngine.bodyPlan}).
 */
export const FAILED_BODY_HOLD_MS = 30_000;

/**
 * HOW MANY MESSAGES THE INSTANT INDEX TAKES ON INSIDE ONE CALL — the bound on both synchronous
 * paths: the FIRST build (above it, {@link SearchIndex.buildSliced} off the keystroke path) and
 * one incremental catch-up (above it, the index is rebuilt from scratch instead).
 *
 * SET FROM THE MEASURED RATE, not guessed: indexing runs at 22 microseconds a message (30 000 in
 * 656 ms, this host, 2026-09-13), so one 16 ms frame buys about 730 and five hundred leaves
 * margin for a slower core. It is the ceiling entered at the TOP of each call, so no amount of
 * mail arriving at once turns a keystroke into a whole-mirror walk.
 */
const SEARCH_INDEX_SYNC_MAX = 500;

/**
 * HOW MANY GATE ARRIVALS ONE SETTLE JUDGES against the mirror's rules before it asks the held-release
 * door without judging. The judgement is a consent index over every rule plus one lookup per
 * sender; past this many senders in one pull the one read is the cheaper answer.
 */
const HELD_ARRIVALS_MAX = 200;

/** One queue page as the route clamps it; the mirror holds the first, and a scroll asks the rest. */
const SCREENER_WAITING_PAGE = 200;
/** How many pages-onward representatives a decision may still be sent for. */
const SCREENER_PAGE_REPS_MAX = 5000;
/** The most senders a walk of the queue's pages records as listed; past it the walk stops speaking. */
const SCREENER_WALK_LISTED_MAX = 1000;
/** The verbs whose success can change who is waiting at the gate. */
const QUEUE_VERBS: ReadonlySet<EngineMutation["kind"]> = new Set<EngineMutation["kind"]>([
  "screener_decide", "rule_create", "rule_update", "rule_delete",
]);

/** The verbs a reader's door can record for the install that organizes the mailbox. */
const TRAVELLING_VERBS: ReadonlySet<EngineMutation["kind"]> = new Set<EngineMutation["kind"]>([
  "screener_decide", "rule_create", "rule_update", "rule_delete", "move", "message_delete",
]);

/** The request kind an in-session verb travels as, until the server lists it. */
const WIRE_KIND: Partial<Record<EngineMutation["kind"], string>> = {
  screener_decide: "screener.decide", rule_create: "rule.create", rule_update: "rule.update",
  rule_delete: "rule.delete", move: "message.move", message_delete: "message.move",
};

/** A queue row off the wire as the mirror stores it. */
/** Do two pages name the same left-out mailboxes (`gone`, sorted; absent from an older server)? */
function sameGone(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function waitingRow(item: ScreenerWaitingItemWire, order: number, total: number): ScreenerWaitingSenderDTO {
  return {
    id: `sender:${senderKey(item.address)}`, kind: "sender", order, messageId: item.messageId,
    address: item.address, name: item.name, receivedAt: item.receivedAt, subject: item.subject,
    snippet: item.snippet, mailboxId: item.mailboxId, total, ...(item.marked ? { marked: true } : {}),
    ...(item.claimsOnly ? { claimsOnly: true } : {}),
  };
}

/**
 * HOW MANY OF THE MESSAGES A SURFACE LAST ASKED TO RENDER THE WINDOWED PRUNE HOLDS ON TO. Exported because it is a
 * policy number a guard depends on, and a guard that hand-copies the number it is checking goes green against a
 * shipped value it has never seen. Sized so that everything one screen can hold fits several times over — the widest
 * caller is the Screener preview, which hydrates one sender's whole held list in a single effect, and forty is the
 * largest such list this codebase has had a defect about ({@link MAX_CONCURRENT_BODIES}). It is a HOLD, not a cache:
 * it never touches the store, it dies with the tab, and its only effect is to keep the windowed prune off rows a
 * reader is looking at.
 */
export const RENDERED_PINS = 64;

/**
 * HOW MANY HYDRATED BODIES THE MIRROR KEEPS — the bound on the reading session's memory.
 *
 * A `message_body` is client-local, so `/sync` can never remove one; before the window reached the
 * desktop nothing removed one at all, and a session's bodies grew for as long as it stayed open.
 * Each is a whole mail: measured at 57 KB apiece on realistic HTML with an inline image, so the
 * eager pass's thousand alone is 54.5 MB and a long reading session was unbounded.
 *
 * THE BOUND IS THE EAGER WINDOW, AND NOT {@link RENDERED_PINS}, BECAUSE OF A LOOP. An evicted body
 * is an ABSENT record, which `bodyPlan` reads as "never asked" — correct, and what lets the next
 * open re-fetch it from the store on this machine. But `prefetchRecentBodies` asks for the newest
 * {@link EAGER_BODIES_MAX} after every settled drain, so a bound below that would have the eager
 * pass re-fetching what the evictor had just dropped, for ever. Sized here so the two agree: the
 * steady state after an eager pass is exactly full, nothing is dropped that the pass will
 * immediately ask for again, and a reader who opens more than this many messages in one session
 * pays for the most recent thousand rather than for all of them.
 *
 * THE SIZE IS ONLY HALF OF IT — THE ORDER IS THE OTHER HALF, and it used to be write recency,
 * which is the reverse of what this paragraph claims. The pass writes newest-first, so the newest
 * mail was the coldest entry and one poll of K arrivals dropped the K bodies the pass had just
 * fetched; the next pass re-fetched them and its own write dropped the band below. Eviction is by
 * MESSAGE DATE, oldest first ({@link olderFirst}) — the window's own definition, so what the pass
 * wants and what the cache keeps are the same set and the pass settles at zero.
 */
export const BODY_CACHE_MAX = EAGER_BODIES_MAX;

/**
 * HOW LONG AN OPTIMISTIC SENT COPY STANDS before it is dropped on TTL alone. The overlay's real job is to bridge the
 * gap between "the server confirmed the send" and "the worker's Sent-folder watch ingested the copy", which is
 * normally minutes; {@link OhmailEngine.reconcileOptimisticSent} drops it the moment the real row arrives, so this
 * ceiling only bites when that ingest never lands in this session (the tab is closed, the mailbox is slow). Ten
 * minutes is past the ordinary Sent-watch latency and matches `SEND_STALE_AFTER_MS` on the server, so a copy that
 * outlives it is genuinely one whose real row this session will not see, and a stale "sent" row is worse than none —
 * the conversation would carry a message the mirror cannot confirm.
 */
export const OPTIMISTIC_SENT_TTL_MS = 10 * 60 * 1000;

/**
 * How many inherited parts a FORWARD's optimistic sent copy may list — the mirror of the send
 * service's `FORWARD_MAX_PARTS`, kept as a literal because this bundle pulls in no server module
 * (the same rule every compose-cap mirror follows). The send streams at most this many of the
 * original's parts onto the outgoing mail, so a projection listing more would claim files the
 * recipient never got.
 */
export const SENT_FORWARD_MAX_PARTS = 100;

/**
 * What the page row carries beside the queue: its write number, and how far a walk has read past it
 * (`noteQueueWalk`). An equal first page keeps both — dropping `walked` made the walk write it back
 * page by page after every ask, and each write re-derived the lists.
 */
const PAGE_IS_NOT_CONTENT: ReadonlySet<string> = new Set(["ask", "walked"]);

/**
 * Do these puts restate exactly the stored rows of their type — same ids, same entities? Compared
 * as key-sorted JSON (the rows are small and bounded: one queue page, the offer's groups), with
 * `ignore` naming fields — at any depth — that number a write rather than state anything.
 */
function sameStoredEntities(
  stored: ReadonlyArray<{ id: string; entity: unknown }>,
  puts: ReadonlyArray<{ id: string; entity: unknown }>,
  ignore: ReadonlySet<string> = new Set(),
): boolean {
  if (stored.length !== puts.length) return false;
  const byId = new Map(stored.map((e) => [e.id, e.entity]));
  for (const p of puts) {
    if (!byId.has(p.id)) return false;
    if (sortedJson(byId.get(p.id), ignore) !== sortedJson(p.entity, ignore)) return false;
  }
  return true;
}

/* The ignored keys are dropped while each object is rebuilt, never through the replacer's `this`:
   Hermes does not hand the replacer its holder, so a `this` test ignored nothing on the phone and
   every equal queue answer wrote. */
function sortedJson(v: unknown, ignore: ReadonlySet<string>): string {
  return JSON.stringify(v, (_key: string, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (!ignore.has(k)) out[k] = (value as Record<string, unknown>)[k];
    }
    return out;
  });
}

export {
  HELD_ARRIVALS_MAX, PAGE_IS_NOT_CONTENT, QUEUE_VERBS, sameGone, sameStoredEntities, SCREENER_PAGE_REPS_MAX,
  SCREENER_WAITING_PAGE, SCREENER_WALK_LISTED_MAX, SEARCH_INDEX_SYNC_MAX, TRAVELLING_VERBS, waitingRow, WIRE_KIND,
};
