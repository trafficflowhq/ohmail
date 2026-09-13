import { boundFromEnv, IMAP_READ_DEADLINE_MS } from "@trafficflow/core/adapters/imap";
import { ServiceError } from "@trafficflow/services/mail";

/**
 * The API's two IMAP clocks and the one refusal both answer with.
 *
 * Its own module because the doors need it in both directions: `imap-door.ts` owns the dial, and
 * `attachments-adapter.ts` — which the door imports — needs the same refusal for a per-operation
 * clock of its own. One of them importing the other would be a cycle, and duplicating the sentence
 * would be two refusals to know for one fact.
 */

/**
 * The budget for one API-side IMAP door, dial and read together.
 *
 * 20 s: above any honest metadata read of one folder, and far enough below the serverless
 * host's 60 s invocation ceiling that a stated degrade reaches the caller instead of the
 * platform's own timeout. Overridable per deployment, refused by name on a non-numeric value —
 * the same rule and the same reader as the adapter's ceilings, so there is one refusal to know.
 */
export const IMAP_DOOR_DEADLINE_MS = boundFromEnv("TF_IMAP_DOOR_DEADLINE_MS", 20_000);

/**
 * THE PER-OPERATION CLOCK, for a door that holds ONE adapter across several operations.
 *
 * The attachment walk is that door: it opens one connection, fetches part after part under its
 * byte and part ceilings, and closes the socket itself. `IMAP_DOOR_DEADLINE_MS` is the wrong shape
 * for it in both directions — it would end an honest multi-part download that is making steady
 * progress, and it would bound nothing at all if it were measured per operation, since 20 s is
 * chosen against a serverless invocation and not against a download. So the UNIT is one operation:
 * a hung fetch ends, a long honest lifetime lives.
 *
 * The NUMBER is the adapter's own {@link IMAP_READ_DEADLINE_MS} and not a new literal — it is
 * exactly the same question ("how long may one read of one mail server take before the answer is
 * that we could not read it") and it is answered there against the socket's inactivity timer,
 * which a byte-a-minute reply resets for ever. A second number here would be a second thing to
 * keep true.
 */
export const IMAP_OPERATION_DEADLINE_MS = IMAP_READ_DEADLINE_MS;

/**
 * OUR clock ran out, not the server's answer.
 *
 * ONE shape, and it is the refusal itself rather than a private class every door has to remember
 * to convert: a door that forgets would answer 500 for a condition the product has a sentence
 * for. A layer with its own answer for "could not look" — the organizer peek, the settings read —
 * recognises it with {@link isImapDoorTimeout} and substitutes; everything else lets the 504
 * stand, which is what it means.
 */
export const imapDoorTimedOut = (budgetMs = IMAP_DOOR_DEADLINE_MS): ServiceError => new ServiceError(
  "mailbox_read_timeout", 504,
  `the mailbox did not answer within ${Math.round(budgetMs / 1000)} seconds — try again`,
  { retryAfterSeconds: 5 },
  true,
);

/**
 * By CODE and not by class, for the middleware's reason: two copies of the services package must
 * not make the same error unrecognisable.
 */
export const isImapDoorTimeout = (err: unknown): boolean =>
  typeof err === "object" && err !== null
  && (err as { code?: unknown }).code === "mailbox_read_timeout";

/**
 * Race `work` against `ms`, and DISARM the loser.
 *
 * `Promise.race` picks the value the caller sees and cancels nothing: the abandoned side settles
 * later with nobody awaiting it, which in Node is an unhandled rejection. This repository has
 * spent an outage on exactly that — an IMAP failure arriving out of band and taking the process
 * with it — so the noop catch goes on the ORIGINAL promise, before the race. The timer is
 * cleared on both arms and unref'd: a pending deadline must never be why a process stays alive.
 */
export async function raced<T>(work: Promise<T>, ms: number): Promise<T> {
  work.catch(() => { /* the deadline arm owns the answer; this arrival is only being disarmed */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(imapDoorTimedOut(ms)), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
