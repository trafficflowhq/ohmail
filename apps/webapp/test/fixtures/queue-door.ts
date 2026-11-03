import { HttpAdapter, type ScreenerWaitingWire } from "@ohmail/client-engine";

/** One waiting sender as `GET /screener` lists it: the representative, and the route's `checked` where it has one. */
export interface QueueRow {
  messageId: string;
  address: string;
  receivedAt: string;
  checked?: Record<string, unknown>;
}

/**
 * THE STORE'S QUEUE DOOR, answering one whole first page over these rows as the route does, read
 * through the adapter's own parse: a surface test meets the page the engine builds from the wire.
 */
export function queueDoor(rows: readonly QueueRow[]): (page?: { cursor?: string; limit?: number }) => Promise<ScreenerWaitingWire> {
  const http = new HttpAdapter({
    baseUrl: "http://queue.test",
    fetch: async () => new Response(JSON.stringify({
      items: rows.map((r) => ({
        id: r.messageId, messageId: r.messageId, threadId: null, mailboxId: "mb",
        sender: { name: null, address: r.address }, subject: "", snippet: "", receivedAt: r.receivedAt,
        aiSuggestion: null, updatedAt: r.receivedAt, ...(r.checked ? { checked: r.checked } : {}),
      })),
      nextCursor: null, total: rows.length, pendingDecisions: [], gone: [],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  return (page) => http.screenerWaiting(page);
}
