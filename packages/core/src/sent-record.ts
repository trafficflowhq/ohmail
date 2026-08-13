import { commitChange, planChange, type ProcessResult } from "./pipeline.js";
import type { AppendedSent } from "./send.js";
import type { Change, RepoPort, RoutingPort } from "./ports.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  RECORD-AT-SEND — project the Sent-folder copy this send just made, instead of rediscovering it
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## What it is, and the one thing it is not
 *
 * `ImapAdapter.send` delivers over SMTP and then `APPEND`s the compiled message into the mailbox's
 * own Sent folder. So by the time a send returns, THE MASTER ALREADY HOLDS THE MESSAGE — and every
 * surface in the product held nothing, because the only writer of a `messages` row was the sync
 * worker's next pass over that folder — a whole poll interval between pressing Send and the message
 * existing anywhere the reader can see it.
 *
 * This function writes that row now. It is a PROJECTION OF A WRITE ALREADY MADE, never a second
 * source of truth: nothing here touches the mailbox, and the Sent-folder watch is untouched and
 * remains the backstop — anything this projection declines to do, gets wrong, or never reaches
 * heals on the worker's next cycle. The IMAP mailbox stays the master by construction.
 *
 * ## THE ONE HAZARD, AND WHY THIS TAKES BYTES RATHER THAN A MESSAGE OBJECT
 *
 * A message's identity is `identity.ts#messageFingerprint` over `normalizeMime`'s reading of the
 * RAW SOURCE — the Message-ID, the addresses in header order, the subject, the `Date:` epoch, and
 * sha256 of each body part and each attachment. It is not derived from the outgoing
 * `OutboundMessage` and it cannot be: `MailComposer` chooses boundaries, folds headers, and picks
 * transfer encodings, and any of those choices changes a body hash.
 *
 * `OutboundMessage` does not even carry a date: `MailComposer` stamps `Date:` at build time and it
 * exists nowhere else, so anything that assembles an equivalent message afterwards stamps a
 * different instant — and the body drifts too, because the composer normalizes newlines and ends
 * the part with one. Either alone is a different fingerprint.
 *
 * So the fingerprint of the projected row MUST come from the exact bytes that were appended, parsed
 * by the same `normalizeMime` ingest uses. That is why {@link AppendedSent} carries `raw` out of the
 * adapter (see `SendResult.raw`) and why this function's only content input is that Buffer.
 *
 * ── WHAT DRIFT ACTUALLY COSTS, MEASURED RATHER THAN ASSUMED ─────────────────────────────────
 *
 * The drift was mutated in — by restamping `Date:` on the bytes handed to the pipeline below — and
 * the damage is NOT where it was first predicted, which is worth writing down because the wrong
 * version of this warning invites the wrong defence:
 *
 *  · The worker's own Sent-folder re-observation SURVIVES it. Its `Change` is `ownAuthored`, so
 *    `resolveExisting`'s own-sent-twin arm matches on Message-ID alone, finds the row whatever its
 *    key says, and `classifyDedup` still answers `duplicate`. The Sent door masks the mistake.
 *  · The INBOUND door does not, and that is the real exposure. A self-CC, a mailing list echoing
 *    your own post back, or any second delivery of the same message arrives NOT own-authored — the
 *    twin arm is gated off for exactly the forgery reason it exists — so with a drifted key both
 *    lookups miss and the copy ingests as a BRAND NEW `messages` row. The user's own message,
 *    twice, in every client, with no delta that removes either.
 *
 * Which is to say: a drifted fingerprint is invisible in the test everyone would write first and
 * permanent in the one they would not. The guard for it is the direct assertion — the stored
 * `dedup_key` IS the key of the bytes at the row's locator — plus the self-CC case.
 *
 * ## WHY IT RUNS THE ORDINARY INGEST AND NOT A HAND-ROLLED INSERT
 *
 * `planChange` + `commitChange` over a synthetic `Change` is not laziness — it is the only way to
 * be SURE the identity agrees with ingest's, because it is literally ingest's own code reading the
 * same bytes. A bespoke `insertMessage` here would have to restate the fingerprint, the threading,
 * the body storage, the attachment metadata, the `unread` decision and the folder state, and each
 * restatement is a place the two paths can drift apart later, silently, in the direction of a
 * duplicate row.
 *
 * Three properties of the `Change` below carry the whole behaviour:
 *
 *  · `ownAuthored: true` — TRUE, and true for the same reason the adapter stamps it on a Sent-folder
 *    read: this mail was written by the account owner. `planChange` returns on it before the rules,
 *    before the Screener and before the money gate (`pipeline.ts`, "MAIL THE USER WROTE LEAVES THE
 *    PIPELINE HERE"), so the projected row is routing-inert — `desired === arrival`, no move is ever
 *    issued, no AI action is billed, and the user's own message is never held for their own consent.
 *  · `type: "create"` — never `"move"`. Nothing disappeared; a copy appeared, because we put it there.
 *  · `locator` — the append's own UID. This is also what makes the projection FREE on the worker
 *    side: `insertMessage` writes the primary `message_instances` row, so `listKnownLocators` reports
 *    that UID as known and the adapter does not even re-fetch it. The dedup path below is the
 *    fallback for when it does (a re-rendered provider copy, or a `0:0` ref), not the common case.
 *
 * ## WHAT THE WORKER DOES WITH IT AFTERWARDS — the three shapes, all one row
 *
 *  1. **The same bytes at the same UID.** `fp1:` hit ⇒ `existing` found; observed folder equals the
 *     known folder ⇒ `classifyDedup` answers `duplicate` BEFORE any evidence test. No second row, no
 *     `change_log` row, no placement.
 *  2. **A re-rendered copy at a different UID** — Exchange Online files its own version of every
 *     submission beside ours, with a new `Received:` chain and re-encoded MIME. Different bytes ⇒
 *     different fingerprint ⇒ both key lookups miss, and `resolveExisting`'s own-sent-twin arm
 *     (Message-ID, gated on `ownAuthored`) finds the projected row. Same folder ⇒ `duplicate` again,
 *     and `commitChange` repoints the locator at the copy the server kept.
 *  3. **A copy in ANOTHER folder** — a self-CC, a list echo. Different folder + `ownAuthored` ⇒
 *     `own_copy`, which records the instance and writes no placement and no delta.
 *
 * ## BEST-EFFORT IS A PROPERTY OF THE CALLER, NOT OF THIS FUNCTION
 *
 * This throws whatever the pipeline throws. It must be called AFTER the send has been recorded as
 * `sent` and its result must never be allowed to fail the request: the mail has already left the
 * building, and turning a delivered message into an error response is strictly worse than a row
 * that appears a minute later. `SendService.projectSentCopy` is the swallow-and-log site.
 */
export interface RecordSentDeps {
  accountId: string;
  mailboxId: string;
  /** The READ phase's repo — outside any transaction, exactly as the worker's plan phase is. */
  repo: RepoPort;
  /**
   * Run the persist phase in ONE short transaction with a transaction-scoped repo.
   *
   * A callback rather than a `Tx`, so this module needs no drizzle and no schema: the caller owns
   * how a transaction is opened and what a repo over it is (`makeDrizzleRepo(tx)`), and this file
   * stays a statement about the pipeline.
   */
  withTx<T>(run: (txRepo: RepoPort & RoutingPort) => Promise<T>): Promise<T>;
}

/**
 * Project one just-appended Sent copy into the database. See the module header — above all the
 * paragraph on why `appended.raw` is the only admissible content input.
 *
 * Returns the pipeline's own outcome, which is `"new"` for the ordinary send and `"duplicate"` for
 * a replay (a same-key retry that re-finalizes, or a second projection of one append). Both are
 * correct and neither writes a second row.
 */
export async function recordSentMessage(
  appended: AppendedSent,
  deps: RecordSentDeps,
): Promise<ProcessResult> {
  const { accountId, mailboxId, repo } = deps;
  const change: Change = {
    type: "create",
    locator: appended.locator,
    raw: appended.raw,
    // The append set `\Seen` itself, so this is the server's state and not a guess. `planChange`
    // forces `seen: true` for own-authored mail regardless (nothing the user wrote is new to
    // them), so this line is the honest value rather than the load-bearing one.
    seen: true,
    ownAuthored: true,
  };
  // NO `classifier`, NO `credits`, NO `routing`, NO `ohboxPolicy`, NO `screeningCutoff` — and the
  // absence is the guarantee, not an omission. `ownAuthored` returns before every one of them is
  // read, so passing them would be describing a code path that cannot execute; leaving them out
  // means a future edit that moves that early return also breaks the build here.
  const plan = await planChange(change, { repo, accountId, mailboxId });
  return deps.withTx((txRepo) =>
    commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId }),
  );
}
