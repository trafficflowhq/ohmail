import { boundFromEnv } from "@trafficflow/core/adapters/imap";
import { ServiceError } from "@trafficflow/services/mail";
import { openMailboxImap, type OpenAdapterOptions, type OpenedMailboxImap } from "./attachments-adapter.js";
import type { ApiDeps } from "./deps.js";

/**
 * ═══ EVERY API-SIDE IMAP DIAL RUNS UNDER ONE BUDGET AND ENDS ITS SOCKET ═════════════════════
 *
 * A door here dials a mail server nobody vetted, on a request a signed-in caller can repeat.
 * Three of them had no wall clock: they dialled, read, and put the socket down in a `finally`
 * with `close()` — a graceful LOGOUT, which the driver QUEUES BEHIND the command that is
 * hanging. So a server that accepts a command and never answers held the connection, the
 * mailbox's slot in the shared per-mailbox cap, and the request's own invocation, and the
 * teardown written to release them waited in the same queue.
 *
 * Nothing else in the stack sees it. `PROBE_TIMEOUTS.socketMs` and its siblings are Node's
 * INACTIVITY timers, reset by every byte, so a reply arriving a byte a minute is never idle.
 *
 * Two rules, and they are one mechanism: ONE budget for dial and read together, and a breach
 * DESTROYS the socket (`forceClose`) rather than asking it politely to end. The destroy is what
 * makes holding the slot until the socket is down affordable — a graceful close on a hung
 * connection is unbounded, and that is why the release used to be allowed to run first.
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
async function raced<T>(work: Promise<T>, ms: number): Promise<T> {
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

/**
 * ONE deadline-raced, force-closed dial of one mailbox, running `work` on the opened adapter.
 *
 * The slot goes back only after the socket is DOWN, which is `OpenedMailboxImap`'s own
 * guarantee for both endings — so the only thing this has to get right is choosing the ending:
 * the polite one when the read finished, the destroying one whenever it did not.
 */
export async function withinDoorBudget<T>(
  deps: ApiDeps,
  mailboxId: string,
  work: (adapter: OpenedMailboxImap["adapter"]) => Promise<T>,
  opts: { budgetMs?: number; open?: OpenAdapterOptions } = {},
): Promise<T> {
  const budgetMs = opts.budgetMs ?? IMAP_DOOR_DEADLINE_MS;
  const startedAt = Date.now();
  const remaining = (): number => Math.max(1, budgetMs - (Date.now() - startedAt));
  const openedP = openMailboxImap(deps, mailboxId, opts.open ?? {});
  let opened: OpenedMailboxImap;
  try {
    opened = await raced(openedP, remaining());
  } catch (err) {
    // A dial that comes up AFTER we gave up on it still holds both slots, and nothing else will
    // ever hold a handle to it. Destroyed when it lands; never awaited, or the wait we just
    // escaped is the wait we take here.
    void openedP.then((o) => o.forceClose()).catch(() => { /* it never came up */ });
    throw err;
  }
  try {
    const got = await raced(work(opened.adapter), remaining());
    await opened.close().catch(() => { /* the socket is already gone; the slots are released */ });
    return got;
  } catch (err) {
    await opened.forceClose().catch(() => { /* already down */ });
    throw err;
  }
}
