import { MAX_CONCURRENT_BODIES } from "@ohmail/client-engine";

/**
 * WHICH OF THE SELECTED SENDER'S HELD BODIES ARE ASKED AS AN OPEN MESSAGE IS ASKED.
 *
 * A person is reading the held preview, so its bodies must not queue behind background work:
 * behind four busy slots the preview said "Couldn't load" at the stall bound with the body one
 * ask away (2026-09-24). The newest held messages, up to the limiter's width, carry `urgent`; the
 * rest wait their turn, because urgency for all forty of a busy sender is the burst the limiter
 * exists to stop. `ids` is the preview's own order, oldest first, so the newest are the last.
 */
export function heldBodyAsks(ids: readonly string[]): Array<{ id: string; urgent: boolean }> {
  const from = Math.max(0, ids.length - MAX_CONCURRENT_BODIES);
  return ids.map((id, i) => ({ id, urgent: i >= from }));
}
