import type { Logger } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   RETIRED — this pass is deliberately empty, and deleting the file is not the same thing.

   ── WHAT IT USED TO DO ─────────────────────────────────────────────────────────────────────

   On every mailbox attach it read the server's Sent folder, imported every recipient it found
   straight into `contacts`, and then re-routed the held Screener mail of the senders it had
   just invented — writing desired folders and `move` changes, which the reconciler turns into
   real IMAP moves inside somebody's mailbox.

   It was written to solve a real problem: `contacts` starts empty, the routing layer screens
   any sender that is not in it, and so on day one every human being who wrote to you was a
   stranger, including the ones answering a thread you started. The diagnosis was right.

   ── WHY IT IS GONE ─────────────────────────────────────────────────────────────────────────

   The fix read consent off a folder listing and acted on it without asking. Two halves, both
   of which the product now says the opposite of:

     · SILENT CONSENT. Having written to somebody IS the strongest signal a mailbox carries —
       that part survives, and is now the whole basis of the sent-mail seed. What changed is
       that the list is SHOWN first. The user sees who was found, unchecks anybody they do not
       want, and confirms; that confirmation is the consent event, and there is no other.
     · A PHYSICAL MOVE ON CONNECT. Connecting a mailbox is a read-only import: nothing moves,
       nothing is decided, and placement is never read as consent. A pass that re-filed a
       backlog at attach time contradicted that in the most visible way possible — in every
       other mail client the person owns.

   Presentation now does what the moves were for. Mail from a sender with no decision behind
   them is presented by consent rather than by folder, so a newly consented sender's old mail
   appears in the Ohbox with zero server moves and the rest waits in History.

   ── WHY THE FUNCTION STILL EXISTS ──────────────────────────────────────────────────────────

   The attach path calls it, and that call site is measured (`mailbox_attached` carries a
   `kickstartMs` phase field whose sum against `attachMs` is asserted). Emptying the pass and
   removing the call are two changes with different blast radii, and they are being made in
   that order. `EMPTY.ran` is `false`, so the caller logs nothing and the phase reports the
   handful of microseconds this takes.

   ── THE ONE THING A LATER PASS MUST NOT DO ─────────────────────────────────────────────────

   `mailboxes.kickstart_at` is still stamped on every mailbox that attached before this, and
   NULL on every one since. It is now a fossil and means nothing. **Never gate new work on
   `kickstart_at IS NULL`** — that predicate reads "this mailbox is owed a pass" and would
   quietly divide the roster by the date it was connected. A pass that needs a marker owes
   itself a new column.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

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
