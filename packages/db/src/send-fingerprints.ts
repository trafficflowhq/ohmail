import { lt } from "drizzle-orm";
/* The mail half directly — see the note in `change-log.ts`. This is a mail table. */
import { outboundSendFingerprints } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * HOW LONG A CONTENT CLAIM IS KEPT ON DISK — hygiene, and NOT the duplicate window.
 *
 * The window a duplicate send is refused inside is `SEND_DUPLICATE_WINDOW_MS`
 * (`@trafficflow/services`, one hour), and it is compared against the request clock in the send
 * path itself. This is a different number for a different job: how long a spent row is allowed to
 * sit in the table before a sweep removes it.
 *
 * Twenty-four hours, comfortably past the window, so a row this deletes can no longer refuse
 * anything and the sweep can never be the reason a send is admitted or refused. That separation is
 * the point rather than a nicety: a standalone install runs the same send path and has NO
 * maintenance pass at all, so anything the expiry actually depended on would be unbounded there —
 * identical re-sends refused for ever on every desktop, with the hosted suite green.
 */
export const SEND_FINGERPRINT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Delete every content claim older than {@link SEND_FINGERPRINT_RETENTION_MS}. Run from the
 * worker's maintenance pass beside `pruneIdempotencyKeys`.
 *
 * A SIZE control and never a correctness one. Row growth is bounded by DISTINCT sends rather than
 * by attempts — the send path re-points an existing claim instead of inserting a second — so the
 * table is small by construction and a failed sweep costs a little disk and nothing else. Nothing
 * waits on it and no send's answer changes because it did or did not run.
 */
export async function pruneSendFingerprints(tx: Tx, now: Date): Promise<number> {
  const gone = await tx
    .delete(outboundSendFingerprints)
    .where(lt(outboundSendFingerprints.createdAt, new Date(now.getTime() - SEND_FINGERPRINT_RETENTION_MS)))
    .returning({ id: outboundSendFingerprints.id });
  return gone.length;
}
