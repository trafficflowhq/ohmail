import type { ConnectedSession } from "./pairing.js";
import { relayedOf, type RelayedDecision } from "../state/relay";
/**
 * The waiting queue as the server holds it — `GET /screener`, a derivation over mail physically in
 * `ohmail/Screener`, one row per sender (`screener-service.ts#list`), consulting no rules: a sender
 * whose mail is at the gate is waiting, whatever this account decided later. The client partition
 * re-homes a DECIDED sender's gate mail for display, so this read is the Screener's source of truth
 * and the partition the offline fallback; the surface says which it shows. Every page is asked
 * through the engine's own door, which remembers each representative it served, so a decision on
 * a sender this windowed mirror holds no mail of is still sent. `null` means "could not ask".
 */

/** One waiting sender, as the route states them. The representative message, and who sent it. */
export interface ServerWaitingSender {
  /** The representative held message — the id `POST /screener/:id` resolves. */
  messageId: string;
  address: string;
  name: string | null;
  /** The representative's own instant, ISO-8601 — the order the route returns them in. */
  receivedAt: string;
  subject: string;
  snippet: string;
  /** The route's `checked.claimsOnly`: a screen-out of this sender files its claims alone (mail 0150). */
  claimsOnly?: true;
}

/**
 * How many pages this read will follow before giving up. The route clamps its own limit, and an
 * account with more waiting senders than this has a queue no phone screen can work through in
 * one sitting — a bound, so a server that never stops handing out cursors cannot spin here.
 */
const MAX_PAGES = 25;

/** One walk of the queue: the waiting senders and, off its first page, this phone's relayed decisions. */
export interface ScreenerQueueRead {
  waiting: ServerWaitingSender[] | null;
  relayed: RelayedDecision[] | null;
}

/**
 * Read the whole waiting queue, or `null` for "could not ask". A page can come back EMPTY WITH A
 * CURSOR STILL SET, meaning "keep going" (`screener-service.ts:523`): the page filters decided
 * senders out after the keyset took its rows, so a window all-decided on another door answers
 * `items: []` with queue behind it. Stopping on an empty page would read a full queue as empty —
 * the failure this loop is written against — so only `nextCursor === null` ends it. A refused page
 * in the middle abandons the WHOLE read: a partial queue is one missing senders, the defect this
 * route was brought in to fix.
 */
export async function readScreenerWaiting(
  session: ConnectedSession,
): Promise<ServerWaitingSender[] | null> {
  return (await readScreenerQueue(session)).waiting;
}

/**
 * THE QUEUE AND THIS PHONE'S OWN DECISIONS STILL WITH THE ORGANIZER, in one walk: the route's
 * `pendingDecisions` ride the first page, so they are taken from it rather than asked again.
 * Each half is `null` for "could not ask", never "nothing is waiting".
 */
export async function readScreenerQueue(session: ConnectedSession): Promise<ScreenerQueueRead> {
  let relayed: RelayedDecision[] | null = null;
  try {
    const out: ServerWaitingSender[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      // The engine's parse keeps a row only when it names a message to decide and an author.
      const got = await session.engine.screenerWaitingPage(cursor);
      if (got === null) return { waiting: null, relayed };
      if (page === 0 && got.pendingDecisions !== undefined) {
        relayed = got.pendingDecisions.map(relayedOf).filter((d): d is RelayedDecision => d !== null);
      }
      for (const s of got.senders) {
        out.push({
          messageId: s.messageId, address: s.address, name: s.name,
          receivedAt: s.receivedAt, subject: s.subject, snippet: s.snippet,
          ...(s.claimsOnly ? { claimsOnly: true as const } : {}),
        });
      }
      cursor = got.nextCursor;
      if (cursor === null) return { waiting: out, relayed };
    }
    /* The page bound was reached with a cursor still in hand. What is in `out` is a PREFIX of the
       queue, and a prefix is the short list this read exists to stop reporting — so it is not an
       answer, and the caller keeps the partition's own list instead. */
    return { waiting: null, relayed };
  } catch {
    return { waiting: null, relayed };
  }
}
