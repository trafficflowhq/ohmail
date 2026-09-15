import type { ConnectedSession } from "./pairing.js";
/* THE ONE BASE EVERY REQUEST IS COMPOSED OFF — see `request-base.ts`. */
import { requestBase } from "./request-base";
/**
 * The waiting queue as the server holds it — `GET /screener` over the paired server. The server's
 * queue is a derivation over mail physically in `ohmail/Screener`, one row per sender
 * (`screener-service.ts#list`), consulting no rules: a sender whose mail is at the gate is waiting,
 * whatever this account decided later. The client partition re-homes a DECIDED sender's gate mail
 * for display, so that sender leaves the derived queue while their mail is still held. On a paired
 * door this read is the Screener's source of truth; the partition is the offline fallback, and the
 * surface says which it shows. Transport is `session.fetch` only; `null` means "could not ask",
 * never "nobody is waiting".
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
}

/**
 * How many pages this read will follow before giving up. The route clamps its own limit, and an
 * account with more waiting senders than this has a queue no phone screen can work through in
 * one sitting — a bound, so a server that never stops handing out cursors cannot spin here.
 */
const MAX_PAGES = 25;

/** A row is kept only when it can be acted on: an id to decide against and an address to name. */
function rowOf(raw: unknown): ServerWaitingSender | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sender = (typeof r.sender === "object" && r.sender !== null ? r.sender : {}) as Record<string, unknown>;
  const messageId = typeof r.messageId === "string" && r.messageId !== ""
    ? r.messageId
    : typeof r.id === "string" ? r.id : "";
  const address = typeof sender.address === "string" ? sender.address : "";
  if (messageId === "" || address === "") return null;
  return {
    messageId,
    address,
    name: typeof sender.name === "string" && sender.name !== "" ? sender.name : null,
    receivedAt: typeof r.receivedAt === "string" ? r.receivedAt : "",
    subject: typeof r.subject === "string" ? r.subject : "",
    snippet: typeof r.snippet === "string" ? r.snippet : "",
  };
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
  try {
    const out: ServerWaitingSender[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = `?limit=200${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await session.fetch(`${requestBase(session)}/screener${q}`, { method: "GET" });
      if (res.status !== 200) return null;
      const body = (await res.json()) as { items?: unknown; nextCursor?: unknown } | null;
      const items = Array.isArray(body?.items) ? body.items : null;
      if (items === null) return null;
      for (const raw of items) {
        const row = rowOf(raw);
        if (row !== null) out.push(row);
      }
      cursor = typeof body?.nextCursor === "string" && body.nextCursor !== "" ? body.nextCursor : null;
      if (cursor === null) return out;
    }
    /* The page bound was reached with a cursor still in hand. What is in `out` is a PREFIX of the
       queue, and a prefix is the short list this read exists to stop reporting — so it is not an
       answer, and the caller keeps the partition's own list instead. */
    return null;
  } catch {
    return null;
  }
}
