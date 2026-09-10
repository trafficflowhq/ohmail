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
 * The AI PROPOSAL-generation pass — a `reconcile-cron` sibling. It
 * assembles the account's REDACTED recurring patterns (metadata only; sensitive mail
 * structurally excluded) and asks the INJECTED WorkflowPort for automation suggestions,
 * REPLACING the account's OPEN proposals (dedup — a re-run never piles up). The core
 * `generateProposals` does the redaction + validation + storage; the worker only injects
 * the port + clock, so the dependency rule holds (the worker imports core+db, NEVER services).
 *
 * Proposals are INERT: this NEVER creates or enables a workflow — the user must
 * explicitly `POST /workflows { fromProposalId }`. Pure/hermetic: db/tx handle + port
 * + clock, so a test drives it against PGlite with a MOCK port and no leader lock.
 */
export async function proposalGeneratePass(
  db: Tx,
  deps: {
    accountId: string;
    port: WorkflowPort;
    /**
     * The AI spend gate. Absent ⇒ unmetered.
     *
     * It is handed to `generateProposals` as its `authorize` callback rather than consulted
     * here, because the two orderings that matter are both inside that function: the charge
     * must come AFTER the patterns are assembled (an account with none reaches no model, and
     * billing for a call that never happens is the one charge the ledger cannot explain) and
     * BEFORE the model. A refusal returns `{ generated: 0 }` without falling through to the
     * transaction whose first act is to DELETE the account's open proposals — degrading to
     * "wipe the suggestions you already had" is a worse experience than showing yesterday's.
     */
    credits?: SpendPort;
  },
  now: Date = new Date(),
): Promise<{ generated: number }> {
  // The BARE key: the pass's own identity, `<accountId>:<UTC hour>`. Bucketing by the hour is
  // what makes a crash-retry free and a deliberate re-run in a later bucket honest.
  const attemptKey = proposalRunId(deps.accountId, now);
  /** What a reversal must name, when this pass charged one. */
  let chargedAttempt: string | null = null;
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
            // `ok` charged this pass, `duplicate` found it already paid for — both proceed. A
            // refusal, an overlap and a fault all abandon the pass without deleting the
            // account's open proposals, which is what `false` does here.
            if (outcome.verdict === "ok") chargedAttempt = outcome.attempt;
            return outcome.verdict === "ok" || outcome.verdict === "duplicate";
          }
        : undefined,
    });
    return { generated: stored.length };
  } catch (err) {
    // Charged for a proposer pass that threw: give it back exactly once, then rethrow so the
    // cron's per-account try/catch logs it and the other accounts still run.
    //
    // Unlike the classify path, refunding is right here: the next pass falls in a LATER period
    // bucket and is charged again, so this pass's charge has no future free retry to honour
    // it. The refund closes the attempt, so a re-run inside the same bucket pays afresh rather
    // than being served free. A no-op when nothing was charged (an empty-pattern pass never
    // reached the gate).
    // Only an attempt THIS pass charged. A `duplicate` names an earlier pass's attempt, whose
    // proposals may well have been delivered; a pass that never reached the gate charged nothing.
    if (deps.credits) {
      await deps.credits.release(deps.accountId, chargedAttempt === null
        ? { action: "propose", attemptKey, refund: false }
        : { action: "propose", attemptKey, refund: true, attempt: chargedAttempt });
    }
    throw err;
  }
}

/**
 * The identity of ONE proposal pass — `<accountId>:<UTC hour>`.
 *
 * It replaces a `randomUUID()` minted per invocation, which made every ledger source unique and
 * therefore made every retry a second charge. The comment defending that read "a sequential
 * re-run genuinely IS a second pass that legitimately costs a second action", which is true of
 * a DELIBERATE re-run and false of the case that actually happens: a crash, a redeploy mid-pass
 * or a container restart re-enters the same logical pass and was billed twice for it.
 *
 * Bucketing by the hour makes the retry free and the deliberate re-run honest, without needing
 * a durable run table. The hour is chosen rather than the day because it is never coarser than
 * a realistic proposal cadence — suggestions are assembled from weeks of behaviour, so nothing
 * sane runs this more than hourly — while still being far wider than any crash-retry window.
 * A genuine second pass tomorrow, or in the next hour, is a new bucket and pays.
 *
 * `now` is the CRON's single clock for the whole invocation (`runProposalCron` computes it once
 * and passes it to every account), so a pass that straddles an hour boundary while working
 * through a long account list still books every account under one bucket.
 */
function proposalRunId(accountId: string, now: Date): string {
  return `${accountId}:${now.toISOString().slice(0, 13)}`;      // yyyy-mm-ddThh
}

/**
 * Cron wrapper (periodic). Guarded by the SAME session-level leader lock the always-on
 * worker + reconcile/bubble-up/workflow crons use: if the live worker holds it, this
 * exits without touching the DB. Otherwise it performs one generation pass PER SERVED
 * ACCOUNT (its shard, narrowed by the optional dev account filter; each account
 * isolated so one failure never skips the rest) and releases. A live model needs an
 * Anthropic key = deployment config — absent, `unconfiguredProposer` proposes nothing
 * and the pass is a clean no-op.
 *
 * `log` defaults to `silentLogger` for the reason `startWorkerWithLock` does: a library
 * function must not print to a host's stdout because an embedder or a test called it. The process
 * a human deploys is the one that turns the logger on, and it does that in `cron-log.ts`.
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
          accountId, port,
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
