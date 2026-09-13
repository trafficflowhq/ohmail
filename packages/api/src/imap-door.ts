import { openMailboxImap, type OpenAdapterOptions, type OpenedMailboxImap } from "./attachments-adapter.js";
import type { ApiDeps } from "./deps.js";
import { IMAP_DOOR_DEADLINE_MS, imapDoorTimedOut, isImapDoorTimeout, raced } from "./imap-budget.js";

/**
 * Every API-side IMAP dial runs under one budget and ends its socket. A door here dials a
 * mail server nobody vetted, on a request a signed-in caller can repeat, and a graceful
 * `close()` is a LOGOUT the driver queues behind the command that is hanging — a server that
 * accepts a command and never answers held the connection, the mailbox's slot in the shared
 * cap, and the invocation, while the teardown waited in the same queue. The socket timeouts
 * are inactivity timers, reset by every byte, so a reply arriving a byte a minute is never
 * idle. Two rules, one mechanism: one budget for dial and read together, and a breach
 * destroys the socket (`forceClose`) — that is what makes holding the slot affordable.
 *
 * The budget, the refusal and the race itself live in `imap-budget.ts`, because the attachment
 * door — which this module imports — needs the same refusal for a per-operation clock of its own
 * and importing back would be a cycle. Re-exported here so every caller keeps one import.
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
