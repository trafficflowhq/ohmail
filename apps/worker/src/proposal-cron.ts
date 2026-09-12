import { UNMETERED, isSpendMetered, type SpendComposition, type Tx } from "@trafficflow/db";
import { makeOwnedDb, makeEntitlementsClient } from "@trafficflow/db/cloud";
import type { SpendPort } from "@trafficflow/db";
import { generateProposals, silentLogger, unconfiguredProposer, type Logger, type WorkflowPort } from "@trafficflow/core";
import { selectionOf, type WorkerConfig } from "./config.js";
import { acquireLeaderLock, leaderLockKeyFor } from "./leader-lock.js";
import { loadServedAccounts } from "./mailboxes.js";
import { isCliEntry } from "./entry.js";
import { cronEvent, runCronCli } from "./cron-log.js";

/**
 * The AI PROPOSAL-generation pass — a `reconcile-cron` sibling. It assembles the account's REDACTED
 * recurring patterns (metadata only; sensitive mail structurally excluded) and asks the INJECTED
 * WorkflowPort for automation suggestions, REPLACING the account's OPEN proposals (dedup — a re-run never
 * piles up). Core `generateProposals` does the redaction + validation + storage; the worker only injects
 * the port + clock, so the dependency rule holds (worker imports core+db, NEVER services). Proposals are
 * INERT: this NEVER creates or enables a workflow — the user must `POST /workflows { fromProposalId }`.
 * Pure/hermetic: db/tx handle + port + clock, so a test drives it against PGlite with a MOCK port.
 */
export async function proposalGeneratePass(
  db: Tx,
  deps: {
    accountId: string;
    port: WorkflowPort;
    /**
     * The AI spend gate. Absent ⇒ unmetered. Handed to `generateProposals` as its `authorize` callback
     * rather than consulted here, because the two orderings that matter are both inside that function: the
     * charge must come AFTER the patterns are assembled (an account with none reaches no model, and billing
     * for a call that never happened is the one charge the ledger cannot explain) and BEFORE the model. A
     * refusal returns `{ generated: 0 }` without falling through to the transaction whose first act is to
     * DELETE the account's open proposals — degrading to "wipe the suggestions you had" is worse than
     * showing yesterday's.
     */
    credits?: SpendPort;
    /** Where the pass says it did not get the claim. Absent ⇒ silent, as a library must be. */
    log?: Logger;
  },
  now: Date = new Date(),
): Promise<{ generated: number }> {
  // The BARE key: the pass's own identity, `<accountId>:<UTC hour>`. Bucketing by the hour is
  // what makes a crash-retry free and a deliberate re-run in a later bucket honest.
  const attemptKey = proposalRunId(deps.accountId, now);
  const log = deps.log ?? silentLogger;
  /** What a reversal must name, when this pass charged one. */
  let chargedAttempt: string | null = null;
  /**
   * DOES THIS PASS HOLD THE CLAIM — `ok` and `duplicate`, and nothing else.
   *
   * The claim is exclusive and its key is `<account>:<hour>`, so a second pass in the same
   * bucket asks about the SAME claim. Releasing one this pass was never granted — an `inflight`
   * loser, a refusal, a throw before the gate — takes it from the holder mid-model-call.
   */
  let claimed = false;
  /** Given back exactly once: set before the await, so a release that faults is never retried. */
  let released = false;
  /**
   * DOES THE ONE RELEASE REVERSE THE CHARGE — the throw path, and nothing else.
   *
   * Unlike the classify path, refunding a throw is right here: the next pass falls in a LATER
   * bucket and is charged again, so this pass's charge has no future free retry to honour it, and
   * the refund closes the attempt so a re-run inside the same bucket pays afresh rather than being
   * served free. Only an attempt THIS pass charged — a `duplicate` names an earlier pass's
   * attempt, whose proposals may well have been delivered, so its claim goes back unrefunded.
   */
  let refundOnRelease = false;
  const releaseClaim = async (refund: boolean): Promise<void> => {
    if (!deps.credits || !claimed || released) return;
    released = true;
    await deps.credits.release(deps.accountId, refund && chargedAttempt !== null
      ? { action: "propose", attemptKey, refund: true, attempt: chargedAttempt }
      : { action: "propose", attemptKey, refund: false });
  };
  try {
    const stored = await generateProposals(db, deps.accountId, {
      port: deps.port,
      now: () => now,
      // The money question, asked by `generateProposals` at the only point where the
      // answer is meaningful: after the patterns exist (so a pass that cannot reach a model is
      // never charged) and before the model is called (so revenue precedes token spend). A
      // `false` here abandons the pass without deleting the account's open proposals.
      authorize: deps.credits
        ? async (patterns): Promise<boolean> => {
            const outcome = await deps.credits!.spend(
              deps.accountId, "propose", attemptKey, { patterns: patterns.length });
            // ANOTHER PASS IS ALREADY BUYING THIS BUCKET: skip the account, and say so. Not a
            // failure — the holder generates the proposals this pass would have — so it is not
            // reported as one, and the line is what tells a skipped account from a stuck pass.
            // Nothing is claimed here, so nothing is released either.
            if (outcome.verdict === "inflight") {
              log.info(cronEvent("proposals", "inflight"), { accountId: deps.accountId });
              return false;
            }
            // `ok` charged this pass, `duplicate` found it already paid for — both proceed, and
            // both hold the claim. A refusal and a fault abandon the pass without deleting the
            // account's open proposals, which is what `false` does here.
            if (outcome.verdict === "ok") chargedAttempt = outcome.attempt;
            claimed = outcome.verdict === "ok" || outcome.verdict === "duplicate";
            return claimed;
          }
        : undefined,
    });
    return { generated: stored.length };
  } catch (err) {
    // The proposer, the store or the gate faulted. Rethrown so the cron's per-account try/catch
    // logs it and the other accounts still run; the claim goes back refunded, at the door below.
    refundOnRelease = true;
    throw err;
  } finally {
    // ONE DOOR, AND AFTER THE STORE. Every exit from the try leaves through here — the return, a
    // throw, and any exit added later — because a release written on the exits somebody had in
    // mind is a release the next exit does not have, and a claim left behind costs the next pass
    // in the window a whole cycle on an account whose work is finished. Not earlier than the
    // store: given back before it there is a window with proposals not yet on record and nothing
    // holding the bucket, where a second pass is told to proceed and buys the same model call
    // again. Nothing is sent when this pass held no claim. A release that faults is reported once
    // and never retried (the latch above), and it never replaces the error the pass is already
    // carrying — an operator needs the fault they can act on, not this one.
    try {
      await releaseClaim(refundOnRelease);
    } catch (err) {
      log.error(cronEvent("proposals", "release_failed"), { accountId: deps.accountId, err });
    }
  }
}

/**
 * The identity of ONE proposal pass — `<accountId>:<UTC hour>`. It replaces a `randomUUID()` minted per
 * invocation, which made every ledger source unique and so every retry a second charge; the old comment
 * ("a sequential re-run genuinely IS a second pass") is true of a DELIBERATE re-run and false of the case
 * that happens — a crash, redeploy or restart re-entering the same logical pass, billed twice. Bucketing by
 * the hour makes the retry free and the deliberate re-run honest with no durable run table: the hour is
 * never coarser than a realistic cadence (suggestions come from weeks of behaviour) yet far wider than any
 * crash-retry window, and a genuine second pass next hour is a new bucket and pays. `now` is the CRON's
 * single clock (`runProposalCron` computes it once), so a pass straddling an hour boundary books every
 * account under one bucket. */
function proposalRunId(accountId: string, now: Date): string {
  return `${accountId}:${now.toISOString().slice(0, 13)}`;      // yyyy-mm-ddThh
}

/**
 * Cron wrapper (periodic). Guarded by the SAME session-level leader lock the always-on worker +
 * reconcile/bubble-up/workflow crons use: if the live worker holds it, this exits without touching the DB;
 * otherwise one generation pass PER SERVED ACCOUNT (its shard, dev-filter narrowed, each isolated so one
 * failure never skips the rest) and release. A live model needs an Anthropic key (deployment config);
 * absent, `unconfiguredProposer` proposes nothing and the pass is a clean no-op. `log` defaults to
 * `silentLogger` for `startWorkerWithLock`'s reason: a library function must not print to a host's stdout;
 * the process a human deploys turns the logger on, in `cron-log.ts`.
 */
export async function runProposalCron(
  config: WorkerConfig, log: Logger = silentLogger,
): Promise<{ ran: boolean; generated: number }> {
  const lock = await acquireLeaderLock(config.databaseUrl, leaderLockKeyFor(config.shardIndex ?? 0));
  if (!lock) return { ran: false, generated: 0 };

  const owned = makeOwnedDb(config.databaseUrl);
  const db = owned.db;
  try {
    const now = new Date();
    const port = config.proposer ?? unconfiguredProposer;
    // Meter the pass ONLY when a real proposer is configured. `unconfiguredProposer`
    // returns `[]` without touching a model, and charging an AI action for a call that
    // reaches no model would be charging for nothing — the one bill the ledger could never
    // explain.
    const metered = config.proposer != null;
    // Composed once, beside the handle it answers from. See the local adapter for why the port
    // holds its own handle rather than taking a caller's transaction.
    /* ONE ENTITLEMENTS PORT FOR THIS INVOCATION, or a named unmetered state — the composition
     * `index.ts` makes, for its reason: `ENTITLEMENTS_URL` set ⇒ the HTTP client, unset ⇒ nothing
     * meters and the spend call sites are handed nothing. */
    const entitlements: SpendComposition = config.entitlements
      ? makeEntitlementsClient({ baseUrl: config.entitlements.url, secret: config.entitlements.secret })
      : UNMETERED;
    const spend = isSpendMetered(entitlements) ? entitlements : undefined;
    let generated = 0;
    for (const accountId of await loadServedAccounts(db, selectionOf(config))) {
      try {
        const res = await proposalGeneratePass(db as unknown as Tx, {
          accountId, port, log,
          // ONE port for the invocation; the account is an argument to the spend and the terms
          // come from `SPEND_ACTIONS.propose`.
          ...(metered && spend ? { credits: spend } : {}),
        }, now);
        generated += res.generated;
      } catch (err) {
        log.error(cronEvent("proposals", "account_failed"), { accountId, err });
      }
    }
    return { ran: true, generated };
  } finally {
    try { await owned.close(); } catch (err) { log.error(cronEvent("proposals", "pool_close_failed"), { err }); }
    await lock.release();
  }
}

if (isCliEntry(import.meta.url)) {
  void runCronCli("proposals", runProposalCron, (r) => ({ ran: r.ran, fields: { generated: r.generated } }));
}
