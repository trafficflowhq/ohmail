import type { Logger } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";

/* RETIRED — this pass is deliberately empty, and deleting the file is not the same thing. It used to read
 * the Sent folder on attach, import every recipient into `contacts`, and re-file the held Screener mail of
 * the senders it invented (real IMAP moves via the reconciler). The diagnosis was right (`contacts` starts
 * empty, so day one every human is a stranger) but the fix read consent off a folder listing and acted on
 * it: SILENT CONSENT (the sent-mail seed now SHOWS the list first and the confirmation IS the consent) and
 * a PHYSICAL MOVE ON CONNECT (connecting is a read-only import; placement is never consent). Presentation
 * now does what the moves were for — mail from an undecided sender is presented by consent, so a consented
 * sender's old mail appears in the Ohbox with zero server moves. The function still exists because the
 * attach path calls it and that call is measured (`mailbox_attached`'s `kickstartMs` vs `attachMs`),
 * `EMPTY.ran` false. `mailboxes.kickstart_at` is now a fossil — NEVER gate new work on `kickstart_at IS NULL`. */

/**
 * Rows a resumable backlog pass handles per transaction.
 *
 * Kept because two later passes were sized against it and cite it (`thread-backfill.ts`,
 * `rule-retro.ts`), and the reasoning is theirs now: `recordChange` takes the account's
 * `account_sync_state` row lock for the length of its transaction, so a whole-backlog
 * transaction would stall every API write for that account. A hundred rows is a few
 * milliseconds of lock.
 */
export const KICKSTART_BATCH = 100;

/** The page cap those passes copied: a bound rather than a `while (true)` against the live database. */
export const KICKSTART_MAX_PAGES = 500;

export interface KickstartDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  log?: Logger;
  now?: () => Date;
  sentScanLimit?: number;
  trustedAuthservIds?: ReadonlySet<string>;
}

export interface KickstartResult {
  /** Always false. The pass is retired; see the header. */
  ran: boolean;
  sentRecipients: number;
  contactsImported: number;
  examined: number;
  rerouted: number;
  truncated: boolean;
}

const EMPTY: KickstartResult = {
  ran: false, sentRecipients: 0, contactsImported: 0, examined: 0, rerouted: 0, truncated: false,
};

/**
 * Does nothing, on purpose. See the file header.
 *
 * It reads no folder, opens no connection, writes no row and emits no change. Attaching a
 * mailbox imports it and organises nothing until its owner says so.
 */
export async function runKickstart(_deps: KickstartDeps): Promise<KickstartResult> {
  return EMPTY;
}
