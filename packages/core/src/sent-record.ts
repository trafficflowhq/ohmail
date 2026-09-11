import { commitChange, planChange, type ProcessResult, type StorageCap } from "./pipeline.js";
import type { AppendedSent } from "./send.js";
import type { Change, RepoPort, RoutingPort } from "./ports.js";

/**
 * Record-at-send: project the Sent-folder copy this send just made. A PROJECTION OF A WRITE
 * ALREADY MADE, never a second source of truth — nothing here touches the mailbox and the
 * Sent-folder watch remains the backstop. It takes BYTES because identity is `messageFingerprint`
 * over the RAW appended bytes (`MailComposer` chooses boundaries and `Date:`), so a fingerprint
 * derived from `OutboundMessage` DRIFTS — invisible at the Sent door, permanent inbound: a
 * self-CC ingests as a brand-new row. It runs the ordinary ingest (`planChange` + `commitChange`)
 * — ingest's own code; `ownAuthored: true` keeps the row routing-inert. Call it AFTER the send is
 * recorded `sent`; it throws, and `SendService.projectSentCopy` is the swallow-and-log site.
 */
export interface RecordSentDeps {
  accountId: string;
  mailboxId: string;
  /**
   * The account's managed storage cap, threaded to `commitChange` — REQUIRED, like every other
   * utterance of it, and METERED on the hosted tier rather than exempt: the same Sent copy also
   * arrives through ordinary sync ingest, whichever path commits first decides storage (the
   * loser exits `duplicate` before the body write), so an exemption here would make own-sent
   * at-cap behavior depend on a race. Bytes are bytes; the sent mail is on the IMAP server —
   * the Sent folder — in full either way.
   */
  storageCap: StorageCap;
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
  // No `classifier`, `credits`, `routing`, `ohboxPolicy` or `screeningCutoff` — the absence is
  // the guarantee: `ownAuthored` returns before every one of them is read, so leaving them out
  // means a future edit that moves that early return breaks the build here. `readerMode: false`
  // IS typed: a reader may send (a reader's send appends to Sent exactly as an organizer's), and
  // the reader arm and the `ownAuthored` arm want the SAME plan — arrival folder kept, nothing
  // decided, no money, no routing row — with `ownAuthored` reached first. Typing `true` would
  // route through a second arm producing the same result by a longer path, diverging the day
  // either arm changes; `false` keeps one answer: the Sent projection is the same program whoever
  // organizes.
  const plan = await planChange(change, { repo, accountId, mailboxId, readerMode: false });
  return deps.withTx((txRepo) =>
    commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId, storageCap: deps.storageCap }),
  );
}
