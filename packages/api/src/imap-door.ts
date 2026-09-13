import { openMailboxImap, type OpenAdapterOptions, type OpenedMailboxImap } from "./attachments-adapter.js";
import type { ApiDeps } from "./deps.js";
import { IMAP_DOOR_DEADLINE_MS, imapDoorTimedOut, isImapDoorTimeout, raced } from "./imap-budget.js";

/**
 * Every API-side IMAP dial runs under one budget and ends its socket. A door here dials a mail
 * server nobody vetted, on a request a signed-in caller can repeat, and a graceful `close()` is a
 * LOGOUT the driver queues behind a hanging command — a server that never answers would hold the
 * connection, the mailbox's slot in the shared cap, and the invocation while the teardown waits
 * in that queue. The socket timeouts are inactivity timers reset by every byte, so a byte-a-minute
 * reply is never idle: one budget for dial and read together, and a breach destroys the socket
 * (`forceClose`). The budget and refusal live in `imap-budget.ts` (re-exported here) so the
 * attachment door can share them without an import cycle.
 */
export { IMAP_DOOR_DEADLINE_MS, imapDoorTimedOut, isImapDoorTimeout };

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
