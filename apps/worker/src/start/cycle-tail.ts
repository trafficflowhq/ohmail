import { type Tx, accounts, pruneIdempotencyKeys, outboundSendFingerprints } from "@trafficflow/db";
import {
  owedSuggestAccounts, clearScreenerSuggestOwed, pruneErasedBearers, pruneErasedNotices, pruneAuthThrottle,
  sweepExpiredStagingFor, reconcileStagingOrphansFor, StagingListingUnsupportedError, accountRows,
} from "@trafficflow/db/cloud";
import { mailboxProviderAuthservIds } from "@trafficflow/core/adapters/drizzle-repo";
import { resolveTailTurn, TAIL_SLICE_BUDGET_MS } from "../config.js";
import { type TailSectionName, TAIL_SECTION_PLAN } from "../cycle-tail-plan.js";
import { isSharedDatabaseFault } from "@ohmail/organizer/dead-letter";
import { asDatabaseFault } from "../db-fault.js";
import { runThreadBackfill, THREAD_BACKFILL_SLICE_PAGES, THREAD_BACKFILL_SLICE_MS } from "../thread-backfill.js";
import { attributedWorkflowDrafter } from "../ai-usage.js";
import { workflowTimeScanPass, workflowDrainPass, unconfiguredDrafter } from "../workflow-cron.js";
import { bubbleUpPass } from "../bubble-up-cron.js";
import { threadJoinHealPass } from "@ohmail/organizer/thread-join-heal";
import { inboundQuietPass } from "@ohmail/organizer/inbound-quiet";
import { ruleRetroPass } from "@ohmail/organizer/rule-retro";
import { gapCatchupPass, NO_FOLDER_READ } from "@ohmail/organizer/gap-catchup";
import { gateReleasePass } from "../gate-release.js";
import { senderCheckRetirement } from "@ohmail/organizer/sender-check-backfill";
import { listAddressBackfillPass } from "@ohmail/organizer/list-address-backfill";
import { pruneWorkerSendFingerprints, retentionPrunePass, signInRetentionPass } from "../retention-prune.js";
import { ohboxTidyPass } from "../ohbox-tidy.js";
import { screenerAutoActPass, screenerActConsentFrom } from "@ohmail/organizer/screener-auto-act";
import { screenerImpersonationPass } from "@ohmail/organizer/screener-impersonation";
import { retireActAdmissionsPass } from "@ohmail/organizer/act-admission-retire";
import { CORRESPONDENT_RETRO_EVERY_MS, screenerCorrespondentRetroPass } from "@ohmail/organizer/screener-correspondent-retro";
import { screenerAutoSuggestPass } from "@ohmail/organizer/screener-auto-suggest";
import { refundObligationDrainPass } from "../refund-obligation-drain.js";
import { throttleKeysFor } from "@trafficflow/db/auth-throttle-keys";
import { accountErasurePass } from "../account-erasure-pass.js";
import { mailboxErasurePass } from "../mailbox-erasure-pass.js";
import {
  searchIndexOwedAccounts, SEARCH_INDEX_ACCOUNTS_PER_TAIL, searchIndexBackfillPass,
} from "@trafficflow/core/mail";
import {
  htmlWordsOwedAccounts, HTML_WORDS_ACCOUNTS_PER_TAIL, htmlWordsBackfillPass,
} from "@ohmail/organizer/html-words-backfill";
import { goneLetterTidyAccounts, goneLetterTidyPass } from "@ohmail/organizer/gone-letter-tidy";
import { storageEvictPass } from "@ohmail/organizer/storage-evict";
import { storageStatsPass } from "../storage-stats.js";
import {
  type EnabledMailbox, loadEnabledMailboxes, organizedMailboxIdsOf, accountShardFilter, shardFilter, accountsOf,
} from "../mailboxes.js";
import { BUBBLE_UP_EVERY_MS, INBOUND_QUIET_EVERY_MS, AWAY_REPLY_REDELIVER_RETRY_MS } from "../index.js";
import type { TailWalk, WorkerScope } from "./scope.js";

/** The worker's start function, one section: the cycle's tail: the maintenance sections, walked in slices between cycles. */
export function cycleTailSection(scope: WorkerScope): void {
    const maintenanceShardKey = `${scope.selection.shards ?? 1}:${scope.selection.shardIndex ?? 0}`;
    const maintenanceAccount = (id: string): Tx => scope.forAccount(id).db as unknown as Tx;
    const { stagingStorage } = scope;
    // ── THE CYCLE TAIL: the per-account passes, walked AFTER the rotation as their own queue entry ──
    //
    // One table, one loop, one cursor. The walk takes a snapshot of the shard's accounts at its
    // start and moves section-major through `TAIL_SECTIONS`; between two slices it yields to a woken
    // mailbox once the turn has run `tailTurn.minTurnMs`, and to whatever is queued once it has run
    // `tailTurn.turnBudgetMs`. A yield re-queues the tail behind the wake's cycle and the next turn
    // resumes at the cursor — never at the top, so no account's passes run twice in one walk. It
    // never opens IMAP (`cycle-tail-census.test.ts`) and is never concurrent with a rotation.
    interface TailSection {
      /** The spelling `cycle_phases` and `/health` use (`cycle-tail-plan.ts`). */
      name: TailSectionName;
      /** Asked once when the walk reaches the section; false skips it whole. */
      gate?: () => boolean;
      /** One shard-wide slice instead of one per account. */
      shard?: true;
      /** Once on entry: the accounts this section walks (default: the snapshot). */
      enter?: (accounts: readonly string[]) => Promise<readonly string[]>;
      run: (accountId: string, walk: TailWalk) => Promise<void>;
    }
    const tailTurn = resolveTailTurn(scope.config.tailTurn);
    scope.tailWalk = null as TailWalk | null;
    scope.tailQueued = false;
    /** The owed serve's read instant: a hold landing mid-walk keeps its mark for the next walk. */
    scope.owedReadAt = new Date(0);
    /** An `until` for one pass call — the shape `mailboxErasurePass` takes. */
    const sliceUntil = (): (() => boolean) => {
      const at = Date.now();
      return () => Date.now() - at >= TAIL_SLICE_BUDGET_MS;
    };
    /** A doorbell is waiting — the same field `noteWake` sets and admission spends. */
    const anyWoken = (): boolean => [...scope.runtimes.values()].some((rt) => rt.wokenAt !== null);

    /** The shard-wide enabled set the walk runs over; a database fault falls back to the duty. */
    async function tailSnapshot(): Promise<readonly EnabledMailbox[]> {
      // The DB passes run over the shard's full enabled set, not the attached duty. This used to be
      // `dutyAccounts` (`accountsOf(served)`, capped at `maxMailboxes`), a cap that exists to bound
      // IMAP CONNECTIONS and nothing else — and neither pass below opens one, so an account whose
      // mailbox fell past the cap had its `workflow_runs` accepted with a 202 and drained by nobody,
      // and its snoozed messages never resurfaced. `dutyAccounts` stays the list for the THREAD
      // BACKFILL, which needs an attached mailbox. Multi-shard is closed by construction
      // (`shardPredicate` is `hashtext(account_id) % shards`). DELIBERATE SCOPE: the list derives from
      // ENABLED MAILBOXES, so a fully-disabled account gets no drain, time scan or bubble-up flip
      // (the intended semantics — a suspended account's automation must not keep firing). FALLBACK, not
      // failure: a database fault degrades to the old narrower list. The tail yields between slices (above).
      /* THE ROWS, and the accounts DERIVED from them — `loadServedAccounts` is exactly
         `accountsOf(await loadEnabledMailboxes(…))` and threw the rows away, which is the mailbox
         scope the bubble-up pass below now needs. One read, same shard predicate, same fallback. */
      let passMailboxes = scope.dutyMailboxes;
      await scope.runTailStage("cycle.loadServedAccounts", "database", async () => {
        passMailboxes = await loadEnabledMailboxes(scope.roster, scope.selection, new Date(), scope.parkedAccountsReader ?? undefined);
      }, (err) => {
        scope.log.error("served_accounts_load_failed", {
          err, accounts: scope.dutyAccounts.length,
          reason: "the shard-wide account list could not be read; this cycle's DB passes run " +
            "over the ATTACHED duty only, so an account past the mailbox cap is skipped once",
        });
      });
      return passMailboxes;
    }

    /** The identity backfill's per-account retirement, for this process's life. */
    const forAccount = (accountId: string): Tx => scope.forAccount(accountId).db as unknown as Tx;
    const senderCheckTail = senderCheckRetirement({ forAccount });
    // BEGIN TAIL_IMPL — the no-IMAP census reads this block: no adapter, runtime or lease here.
    const TAIL_IMPL: { readonly [K in TailSectionName]: Omit<TailSection, "name"> } = {
      screener_suggest_owed: {
        // ── SERVE THE SUGGEST-OWED ACCOUNTS FIRST (cloud 0039) ──────────────────────────────
        // Accounts whose ingest HELD a first-contact sender since their last suggest visit, served
        // at the TOP of the pass sections — the section chain is why a suggestion trailed a landing
        // by over a minute while every piece was healthy. Two sources, union'd: the durable table
        // (survives a crash) and the in-process hints (visible to the SAME cycle that ingested).
        // Intersected with THIS shard's served set. The mark is cleared only up to the read
        // instant, so a hold landing mid-serve keeps its row; the unconditional suggest section
        // below stays as the backstop. All four spend bounds live in the pass, untouched here.
        enter: async (accounts) => {
          scope.owedReadAt = new Date();
          let owedRows: Array<{ accountId: string; owedAt: Date }> = [];
          await scope.runTailStage("cycle.owedSuggestAccounts", "database", async () => {
            owedRows = await owedSuggestAccounts(scope.roster as unknown as Tx);
          }, (err) => {
            scope.log.warn("screener_suggest_owed_read_failed", {
              err,
              reason: "the owed marks could not be read; every opted-in account is still served " +
                "by the suggest section below this cycle — latency, not loss",
            });
          });
          const servedHere = new Set(accounts);
          const owed: string[] = [];
          for (const r of owedRows) {
            if (servedHere.has(r.accountId) && !owed.includes(r.accountId)) owed.push(r.accountId);
          }
          for (const a of scope.suggestOwedHints) {
            if (servedHere.has(a) && !owed.includes(a)) owed.push(a);
          }
          return owed;
        },
        run: async (accountId, walk) => {
          scope.suggestOwedHints.delete(accountId);
          // MIXED: the suggest pass buys from the model and the entitlements program, so only the
          // database-only calls around it carry the tag.
          await scope.runTailStage("cycle.screenerSuggestOwedServe", "mixed", async () => {
            const screening = await scope.screeningFor(accountId);
            const { ran, bought, chargedAttempts, stopped: why, capped } = await screenerAutoSuggestPass(
              scope.forAccount(accountId).db as unknown as Tx,
              {
                accountId, log: scope.log, until: sliceUntil(),
                noteFault: scope.tailFaultNote("cycle.screenerAutoSuggestPass"),
                // No mailbox, deliberately: this pass spends through `spend`, never the circuit's
                // meter, so it has no open charge to clear or refund (`ClassifierCircuit.port`).
                classifier: scope.classifierCircuit?.port(),
                ...(scope.spend ? { credits: scope.spend, access: scope.spend } : { unmeteredLearning: true as const }),
                ...(scope.obligations ? { obligations: scope.obligations } : {}),
                ...(scope.usageRelay ? { usageHook: scope.usageRelay.hook } : {}),
                ...(scope.usageBuffer ? { recordRewriteUsage: (line) => scope.usageBuffer?.push(line) } : {}),
                ...(screening.ohboxBar ? { ohboxBar: screening.ohboxBar } : {}),
              },
            );
            if (ran) walk.suggestedAccounts.add(accountId);
            if (ran && (bought > 0 || why)) {
              scope.log.info("screener_suggest_owed_served", { accountId, bought, chargedAttempts, stopped: why, capped });
            }
            // Cleared after ANY non-throwing pass, opted-in or not: a stale mark for an account
            // that opted out would otherwise lead every cycle for ever.
            await asDatabaseFault("cycle.clearScreenerSuggestOwed",
              () => clearScreenerSuggestOwed(scope.forAccount(accountId).db as unknown as Tx, accountId, scope.owedReadAt));
            // AND ACT ON WHAT IS NOW STORED, on the act's own consent. Here rather than a cycle
            // later so advice bought this serve is acted on this serve.
            const acted = await asDatabaseFault("cycle.screenerAutoActPass", () => screenerAutoActPass(
              scope.forAccount(accountId).db as unknown as Tx, {
                accountId, log: scope.log, until: sliceUntil(), consent: screenerActConsentFrom(accountId),
                noteFault: scope.tailFaultNote("cycle.screenerAutoActPass"),
              }, new Date(),
            ));
            if (acted.ran && (acted.filed > 0 || acted.failed > 0)) {
              scope.log.info("screener_auto_act_pass", { accountId, applied: acted.filed, failed: acted.failed });
            }
          }, (err) => {
            scope.log.error("screener_suggest_owed_serve_failed", {
              accountId, err,
              reason: "the owed serve failed before its mark was cleared, so the next cycle " +
                "retries it; nothing is marked twice and the suggest section below still runs",
            });
          });
        },
      },
      bubble_up: {
        // The bubble-up resurfacing pass, in the loop and time-gated. It lives here rather than a platform
        // cron because `runBubbleUpCron` takes `acquireLeaderLock(…, leaderLockKeyFor(shardIndex))` — the
        // SAME lock this process holds — so a platform cron on this shard would be a process whose only
        // function, while the worker is healthy, is to start, fail to take the lock and exit; the wrapper
        // is a manual backstop for a DEAD worker. Until this call, nothing in production flipped
        // `bubbled_up` back, so `AppShell`'s resurface shortcut showed a DATED promise ("Resurfaces
        // {when}") no code could keep. BEFORE the workflow block, since a message coming due may satisfy
        // a `time` trigger this tick. TIME-GATED, not per-cycle-unconditional and not its own
        // `setInterval` — a second off-queue writer is unearned for one query per account, and an
        // off-queue pass can close an adapter the cycle is walking.
        gate: () => {
          if (Date.now() - scope.lastBubbleUpAt < BUBBLE_UP_EVERY_MS) return false;
          scope.lastBubbleUpAt = Date.now();
          return true;
        },
        run: async (accountId, walk) => {
          // Scoped per account even though this process is the only writer of its shard: the
          // pass's own header explains why (an unscoped pass under a shard-specific lock
          // would let shard 0 mutate shard 1's rows), and per-account isolation keeps one
          // account's failure from skipping the rest.
          /* AND PER MAILBOX, from the roster rows this cycle read: Cloud holds the lease one
             mailbox at a time, so an account whose second mailbox is organized by somebody's
             desktop gets that mailbox's rows left alone. Read here rather than assumed — an
             account this process reads entirely yields an empty set and flips nothing. */
          await scope.runTailStage("cycle.bubbleUpPass", "database", async () => {
            const { flipped } = await bubbleUpPass(scope.forAccount(accountId).db as unknown as Tx, new Date(), {
              accountId, mailboxIds: organizedMailboxIdsOf(walk.mailboxes, accountId),
            });
            if (flipped > 0) scope.log.info("bubble_up_flipped", { accountId, flipped });
          }, (err) => {
            scope.log.error("bubble_up_failed", {
              accountId, err,
              reason: "a snoozed message stayed hidden past its bubble_up_at; the next pass " +
                "retries it, the predicate is the row's own state and nothing is marked",
            });
          });
        },
      },
      workflow: {
        // Per-account DB passes, isolated per account so one account's workflow
        // error can never abort another account's drain — nor the sync cycle.
        run: async (accountId) => {
          await scope.runTailStage("cycle.workflow", "mixed", async () => {
            const nowTick = new Date();
            await asDatabaseFault("cycle.workflowTimeScanPass",
              () => workflowTimeScanPass(scope.forAccount(accountId).db as unknown as Tx, { accountId }, nowTick));
            // NOT wrapped in `asDatabaseFault`: the drain calls the DRAFTER, so a model outage
            // throws from inside it and must not be tagged as our database — the same subtraction
            // `sensitiveBackfillPass` gets, for the same reason.
            await workflowDrainPass(
              scope.forAccount(accountId).db as unknown as Tx,
              {
                drafter: scope.config.drafter && scope.usageRelay && scope.usageBuffer
                  ? attributedWorkflowDrafter(scope.config.drafter, accountId, scope.usageRelay.hook, scope.usageBuffer)
                  : scope.config.drafter ?? unconfiguredDrafter,
                accountId, ...(scope.spend ? { credits: scope.spend, access: scope.spend, consentRefunds: scope.obligations } : {}),
              },
              nowTick,
            );
          }, (err) => {
            scope.log.error("workflow_drain_failed", { accountId, err });
          });
        },
      },
      gate_release: {
        // Give back the mail stuck at the screening gate behind a decision the account already made.
        // BEFORE the retro pass below and in its own runner call and loop, for that loop's reason: one
        // account's failure must not skip the rest. Running first is deliberate — it arms the release
        // licence on rules the retro pass then walks in the SAME cycle, so an affected account is
        // repaired in one pass of the tail instead of two. For every account already swept the call is
        // one indexed read of `account_settings` and no more, and it stops for ever once the marker is
        // stamped. It needs nothing beyond the db and core packages, the same dependency reason the
        // two passes below state without naming the forbidden package (`deps.test.ts` scans this
        // file's raw text).
        run: async (accountId) => {
          await scope.runTailStage("cycle.gateReleasePass", "database", async () => {
            const r = await gateReleasePass(scope.forAccount(accountId).db as unknown as Tx, { accountId, log: scope.log }, new Date());
            if (r.ran && (r.rulesArmed > 0 || r.contactRowsReleased > 0 || r.completed)) {
              scope.log.info("gate_release_swept", {
                accountId, rulesArmed: r.rulesArmed,
                contactRowsReleased: r.contactRowsReleased, completed: r.completed,
              });
            }
          }, (err) => {
            scope.log.error("gate_release_failed", {
              accountId, err,
              reason: "no account was marked swept, so the next cycle starts it again; a rule this " +
                "pass already armed is in flight and drops out of its own selection, and a row it " +
                "already released is desired into the Ohbox and no longer at the gate",
            });
          });
        },
      },
      sender_check_backfill: {
        // The identity fact for the Ohbox and Screener rows ingested before mail 0148, one page per
        // account per tail, then the act's contacts from before it, each contact written once. Once
        // both sets answer empty the account RETIRES in this process; a scoped read on
        // entry re-arms an account a row re-entered (`senderCheckRetirement`). Contained: a failure
        // leaves the rows unchecked until the next tail.
        enter: (accounts) => senderCheckTail.enter(scope.roster as unknown as Tx, accounts, scope.log,
          scope.tailFaultNote("cycle.senderCheckReentered")),
        run: async (accountId) => {
          await scope.runTailStage("cycle.senderCheckBackfillPass", "database", async () => {
            await senderCheckTail.run(scope.forAccount(accountId).db as unknown as Tx, accountId, scope.log);
          }, (err) => {
            scope.log.error("sender_check_backfill_failed", {
              accountId, err,
              reason: "these rows keep no identity fact yet; the Screener page computes it for a held " +
                "representative meanwhile, and the next tail tries the same page again",
            });
          });
        },
      },
      list_address_backfill: {
        // The addresses a mailing list posts as, read once from every stored message (mail 0150).
        // BEFORE the correspondent retro further down, which asks these rows before it releases a
        // claim. One indexed read of `account_settings` per stamped account. Contained: a failure
        // leaves the stamp unwritten and the next tail reads again; ingest records new mail meanwhile.
        // The pass talks only to our database, so its throw is named as the database's and an
        // outage met here is announced for the shard, never swallowed as one account's failure.
        run: async (accountId) => {
          await scope.runTailStage("cycle.listAddressBackfillPass", "database",
            () => listAddressBackfillPass(scope.forAccount(accountId).db as unknown as Tx, { accountId, log: scope.log }), (err) => {
              scope.log.error("list_address_backfill_failed", {
                accountId, err,
                reason: "the account is not stamped, so the next tail reads its stored mail again; " +
                  "what was recorded stays, and new mail records its own list addresses at ingest",
              });
            });
        },
      },
      screener_impersonation: {
        // A held letter that impersonates a company, filed to Spam on its own when owed: no model,
        // no rule, one letter at a time, each listed with its undo. Only the mailboxes this process
        // organizes; the door reads each mailbox's role under lock again. After the list addresses
        // above, which keep a list's claims held.
        run: async (accountId, walk) => {
          // A mailbox whose settings question is open or unread waits: an Import may bring a tie or the off choice.
          const mailboxIds = organizedMailboxIdsOf(walk.mailboxes, accountId)
            .filter((id) => scope.gapClearances.get(id)?.kind === "clear").sort();
          const over = mailboxIds.join(" ");
          if (scope.impersonationSettled.get(accountId) === over) return;
          let senders = scope.impersonationWalks.get(accountId);
          if (senders === undefined) scope.impersonationWalks.set(accountId, senders = {});
          await scope.runTailStage("cycle.screenerImpersonationPass", "database", async () => {
            const r = await screenerImpersonationPass(scope.forAccount(accountId).db as unknown as Tx, {
              accountId, mailboxIds, log: scope.log, until: sliceUntil(), walk: senders,
              noteFault: scope.tailFaultNote("cycle.screenerImpersonationPass"),
            });
            if (r.ran && !r.capped && r.failed === 0) scope.impersonationSettled.set(accountId, over);
          }, (err) => {
            scope.log.error("screener_impersonation_failed", {
              accountId, err,
              reason: "no held letter was filed past the failure and nothing is marked; the account stays owed, "
                + "so the next tail asks again",
            });
          });
        },
      },
      act_admission_retire: {
        // The act's past admissions retired, once per account per process: its allow rules and the
        // contacts only it wrote go, so a stranger it let in waits at the Screener again. A page per
        // tail until the walk ends; no letter moves. After the legacy contacts are marked above.
        run: async (accountId) => {
          if (scope.actAdmissionsRetired.has(accountId)) return;
          await scope.runTailStage("cycle.retireActAdmissionsPass", "database", async () => {
            const r = await retireActAdmissionsPass(scope.forAccount(accountId).db as unknown as Tx, {
              accountId, log: scope.log, ...(scope.actAdmissionCursor.has(accountId) ? { after: scope.actAdmissionCursor.get(accountId)! } : {}),
            });
            if (r.done) { scope.actAdmissionsRetired.add(accountId); scope.actAdmissionCursor.delete(accountId); }
            else if (r.next !== null) scope.actAdmissionCursor.set(accountId, r.next);
          }, (err) => {
            scope.log.error("act_admission_retire_failed", {
              accountId, err,
              reason: "nothing of this page was retired and the walk stays where it was, so the next " +
                "tail asks the same senders again; no letter was moved",
            });
          });
        },
      },
      rule_retro: {
        // Apply a new rule to mail that is already filed. Its OWN runner call and loop, not folded into the
        // workflow block, for that block's reason: one account's failure must not skip the rest. It runs
        // HERE, on the worker, not the API host, because writing thousands of `folder_state` rows inside
        // `POST /rules` is what this slice stops — the sheet used to fire one `POST /messages/:id/move`
        // per match from the browser, each taking the account's sync-state row lock, abandoning the rest
        // if the tab closed. The pass needs nothing from the services package (the db and core packages
        // are its whole imports), which makes this the right host. The package is named in prose, not
        // backticks, on purpose: `deps.test.ts` scans this file's raw TEXT and does not strip comments.
        // NOT time-gated, unlike `bubbleUpPass`: its per-cycle write budget bounds it, its owed probe is
        // one indexed query, and a user who clicked a destination is waiting for their mail to move.
        run: async (accountId) => {
          // The pass talks only to our database, so its throw is named as the database's.
          await scope.runTailStage("cycle.ruleRetroPass", "database", async () => {
            const { moved, completed, capped } = await ruleRetroPass(
              scope.forAccount(accountId).db as unknown as Tx,
              // Per-MAILBOX trust, off the credential row's own IMAP host, because one
              // account's mailboxes can sit at different providers. The pass caches per mailbox.
              { accountId, log: scope.log, trustedAuthservIdsFor: mailboxProviderAuthservIds },
              new Date(),
            );
            if (moved > 0 || completed > 0) {
              scope.log.info("rule_retro_pass", { accountId, moved, completed, capped });
            }
            // The moves are desired state the account's mailboxes push on their next TURN; woken,
            // that turn is the next free lane, not the next pass (the tail yields to a wake).
            if (moved > 0) scope.wakeAccount(accountId);
          }, (err) => {
            scope.log.error("rule_retro_failed", {
              accountId, err,
              reason: "no rule was marked applied and no cursor advanced past uncommitted work, " +
                "so the next cycle resumes from `retro_cursor`; mail already moved is desired " +
                "state the reconciler converges independently of this pass",
            });
          });
        },
      },
      gap_catchup: {
        // MAIL FROM A GAP: what arrived while nothing organized a mailbox this install now
        // organizes, COUNTED for the person and filed by their rules only on their press. After the
        // visit, so the observed folders are this tenure's. Desired state only.
        run: async (accountId) => {
          // Our database only, so its throw is named as the database's: a refused connection is a
          // bare `ECONNREFUSED`, which reads as the shard's only when tagged.
          await scope.runTailStage("cycle.gapCatchupPass", "database", async () => {
            const { offered, moved, completed } = await gapCatchupPass(
              scope.forAccount(accountId).db as unknown as Tx,
              {
                accountId, log: scope.log, trustedAuthservIdsFor: mailboxProviderAuthservIds,
                // Data from the visit, never a runtime: an unvisited or unread mailbox waits.
                clearanceFor: (id) => scope.gapClearances.get(id) ?? NO_FOLDER_READ,
              },
              new Date(),
            );
            if (offered + moved + completed > 0) {
              scope.log.info("gap_catchup_pass", { accountId, offered, moved, completed });
            }
          }, (err) => {
            scope.log.error("gap_catchup_failed", {
              accountId, err,
              reason: "the letters that arrived while nothing organized this mailbox were not counted or "
                + "filed this cycle; the window stays open and the next cycle resumes it",
            });
          });
        },
      },
      ohbox_tidy: {
        // File the already-misfiled automated mail out of the Ohbox. Its OWN runner call and loop: one
        // account's failure must not skip the rest. It is the durable, one-time-per-opt-in half of the
        // `people_only` posture — the live engine demotes NEW mail, this re-routes the backlog placed
        // before the account opted in. Like the retro pass it lives here and needs nothing beyond the db
        // and core packages (the same dependency reason, stated without naming the forbidden package
        // because `deps.test.ts` scans this file's raw text). It is owed work only for an account that
        // flipped to `people_only` or pressed "tidy now", which one PK read checks; for every other
        // account the call is that read and no more. NOT time-gated: its per-cycle write budget bounds it,
        // and an owner who just opted in is waiting for their Ohbox to shrink.
        run: async (accountId) => {
          await scope.runTailStage("cycle.ohboxTidyPass", "database", async () => {
            const { ran, moved, completed, capped } = await ohboxTidyPass(
              scope.forAccount(accountId).db as unknown as Tx,
              // Same per-mailbox trust as the retro pass above, same canonical resolver.
              { accountId, log: scope.log, trustedAuthservIdsFor: mailboxProviderAuthservIds },
              new Date(),
            );
            if (ran && (moved > 0 || completed)) {
              scope.log.info("ohbox_tidy_pass", { accountId, moved, completed, capped });
            }
          }, (err) => {
            scope.log.error("ohbox_tidy_failed", {
              accountId, err,
              reason: "no account was marked done and the cursor advanced only past committed pages, " +
                "so the next cycle resumes from `ohbox_tidy_cursor`; mail already moved is desired " +
                "state the reconciler converges independently of this pass",
            });
          });
        },
      },
      thread_join_heal: {
        // Rejoin the conversations a forward split. A forward re-entering the mailbox carries no
        // References, so one human conversation becomes two header chains and renders as two threads —
        // correctly, under the ingest rule, which is why no ingest change can close it. The heal merges
        // them once the evidence completes (`conversationJoinVerdict` — same account, same base subject,
        // the same non-self correspondent on BOTH chains, the later opening with a reply/forward prefix,
        // inside a 14-day window), performing exactly the merge `POST /threads/merge` performs, change
        // rows included. TIME-GATED like `bubbleUpPass` and unlike the retro/tidy passes, because nobody
        // is waiting on it: it repairs presentation and its own budget bounds a walk. Each slice runs
        // under the slice clock, so a wake never waits behind a whole account's heal; a cut account
        // is resumed by the next tail walks (`thread-join-heal-walk.ts`). Its OWN runner call and loop.
        gate: () => scope.joinHealWalk.due(Date.now()),
        run: async (accountId, walk) => {
          const slice = scope.joinHealWalk.slice(accountId, walk.accounts);
          if (slice === null) return;
          await scope.runTailStage("cycle.threadJoinHealPass", "database", async () => {
            const at = Date.now();
            const r = await threadJoinHealPass({
              db: scope.forAccount(accountId).db as unknown as Tx, apply: true, accountId, log: scope.log, ...slice, until: sliceUntil(),
              noteFault: scope.tailFaultNote("cycle.threadJoinHealPass"),
            });
            // The resume point is carried whatever `failed` says: a group that fails
            // deterministically must not pin every walk to its own page. Transients are already
            // retried once inside the pass.
            const closed = scope.joinHealWalk.settle(accountId, r, Date.now() - at);
            if (r.merged > 0 || r.skipped > 0 || r.failed > 0 || r.cut) {
              // Named fields, not a spread: `r.cursor` carries a thread SUBJECT (user content
              // the census deny-lists), and the counters must land on registered names.
              scope.log.info("thread_join_heal_pass", {
                accountId, scanned: r.groupsScanned, merged: r.merged,
                moved: r.messagesMoved, skipped: r.skipped, failed: r.failed, capped: r.capped, more: r.cut,
              });
            }
            if (closed) {
              scope.log.info("thread_join_heal_walk_closed", {
                accountId, scanned: closed.scanned, slices: closed.slices, ms: closed.ms, more: closed.more,
              });
            }
          }, (err) => {
            scope.joinHealWalk.abandon(accountId);
            scope.log.error("thread_join_heal_failed", {
              accountId, err,
              reason: "no group of this account committed partially — each is one transaction — " +
                "and the candidate predicate is the rows' own state, so the next gated run " +
                "re-reads reality and resumes",
            });
          });
        },
      },
      inbound_quiet: {
        // ── THE INBOUND-QUIET PASS: notice the mailbox a provider-side forward emptied ──────
        //
        // The forwarding-detection heuristic (mail 0078, `inbound-quiet.ts` carries the predicate
        // and the incident). TIME-GATED like the heal above and for its reason: the pass judges
        // fortnight-wide windows, so nothing a user can perceive changes between two cycles, and
        // per-cycle it would be a fleet-wide grouped aggregate bought against no latency. Scoped
        // per account under this shard's lock (bubble-up's argument), its OWN runner call and loop
        // so one account's failure must not skip the rest — and never a cycle abort: the notice
        // is observability, and mail continues to be filed either way.
        gate: () => {
          if (Date.now() - scope.lastInboundQuietAt < INBOUND_QUIET_EVERY_MS) return false;
          scope.lastInboundQuietAt = Date.now();
          return true;
        },
        run: async (accountId) => {
          await scope.runTailStage("cycle.inboundQuietPass", "database", async () => {
            const r = await inboundQuietPass(scope.forAccount(accountId).db as unknown as Tx, new Date(), { accountId });
            if (r.tripped > 0 || r.cleared > 0) {
              scope.log.info("inbound_quiet_pass", { accountId, tripped: r.tripped, cleared: r.cleared });
            }
          }, (err) => {
            scope.log.error("inbound_quiet_failed", {
              accountId, err,
              reason: "the quiet-mailbox judgment was skipped this pass; episodes already " +
                "stamped stand, nothing is cleared or tripped, and the next gated run " +
                "re-reads reality — syncing is untouched",
            });
          });
        },
      },
      away_reply_flag_redeliver: {
        // Re-deliver `autoReplyByUs` to mirrors that predate it. The flag is computed at materialize
        // time, so it reaches a message only when a change_log row for that message does — and every
        // responder reply already in somebody's Ohbox was written before the flag existed, so without
        // this pass the client filters on a field those rows do not carry and the replies stay in
        // "Earlier" for ever, the fix invisible on exactly the mailboxes that reported the bug (found by
        // review as a HIGH). ONCE PER PROCESS, on the first cycle (see the gate's docblock for why no
        // durable marker). Its OWN runner call and loop, and it must never abort a cycle: it writes no
        // state of its own, moves nothing and touches no message row — a change_log row is a re-read
        // instruction — so the next gated run simply re-reads reality.
        shard: true,
        gate: () => {
          if (scope.awayReplySweep.done || Date.now() - scope.lastAwayReplySweepAt < AWAY_REPLY_REDELIVER_RETRY_MS) return false;
          scope.lastAwayReplySweepAt = Date.now();
          return true;
        },
        run: async (_accountId, walk) => {
          /* A throw past `runOnce` reaches the slice net, which is on the runner; one account's
             throw INSIDE it is the per-account catch's, handed to the hook. */
          const awayReplyFault = scope.tailFaultNote("cycle.awayReplySweep");
          // The GATE IS THE SWEEP'S, closed after its own loop and only on a clean full pass. It
          // used to be a boolean set here, before the accounts were walked, which retired the whole
          // fleet's sweep on one account's failure. Its per-account try/catch keeps that shape — one
          // account's failure must not skip the rest — and reports through `onError`.
          const r = await asDatabaseFault("cycle.awayReplySweep",
            // The sweep walks the accounts itself: it is handed the way to each one's handle, never one handle for all.
            () => scope.awayReplySweep.runOnce((accountId) => scope.forAccount(accountId).db as unknown as Tx, [...walk.accounts], {
              readRelations: accountRows,
              log: scope.log,
              onError: (accountId, err) => {
                awayReplyFault(err);
                scope.log.error("away_reply_flag_redeliver_failed", {
                  accountId, err,
                  reason: "no change row for this account committed partially — each page is one " +
                    "transaction — the account keeps its cursor, the sweep stays owed, and the " +
                    "next attempt resumes there; no message was moved or altered",
                });
              },
            }));
          if (r.redelivered > 0 || r.failed > 0) {
            // `capped` carries "the sweep is still owed", NOT a field named `done`:
            // `ALLOWED_FIELDS` drops an unregistered key silently, so `done` would vanish from the
            // line. Inverted rather than renamed, because `capped` already means "the walk did not
            // reach the end" everywhere else in this cycle.
            scope.log.info("away_reply_sweep", {
              accounts: r.accounts, marked: r.redelivered, failed: r.failed, capped: !r.done,
            });
          }
        },
      },
      storage_evict: {
        // ── TRIM THE ROLLING WINDOW: at the storage cap, the oldest stored bodies husk ──────
        //
        // Its OWN runner call and loop, like every pass here: one account's failure must not skip
        // the rest. For every account under its high-water mark the pass is one primary-key read and
        // no more, plus one recount a day in the trim's band (`STORAGE_RECOUNT_EVERY_MS`, its drift
        // logged as `storage_counter_drift`); over it, bounded rounds of bounded batches, resuming next cycle
        // (`storage-evict.ts` carries the hysteresis argument). Registered in this SERIAL
        // per-account section deliberately — the repair passes order body-row-then-counter, the
        // evictor counter-then-body-rows, and serial execution per account is what keeps the two
        // orderings from ever facing each other.
        run: async (accountId) => {
          // MIXED: the cap is the entitlements program's answer; the pass tags its own db calls.
          await scope.runTailStage("cycle.storageEvictPass", "mixed", async () => {
            const { ran, evicted, freedBytes, capped, waitsForErasure } = await storageEvictPass(
              scope.forAccount(accountId).db as unknown as Tx, { accountId, log: scope.log, storageCap: scope.storageCapFor, dbCall: asDatabaseFault }, new Date(),
            );
            if ((ran && evicted > 0) || waitsForErasure) {
              scope.log.info("storage_evict_pass", { accountId, evicted, freedBytes, capped, waitsForErasure });
            }
          }, (err) => {
            scope.log.error("storage_evict_failed", {
              accountId, err,
              reason: "each round is one transaction, so a failure loses nothing durable; the " +
                "counter and the husks move together or not at all, and the next cycle re-probes",
            });
          });
        },
      },
      storage_stats: {
        // ── THE STORAGE ESTIMATE'S SNAPSHOT: the counts a request may not take ──────────────
        //
        // Its own runner call, after the trim, in this serial per-account section: a due mailbox
        // is checked against the change log and confirmed, or read in bounded pages, each statement
        // under its own timeout (`storage-stats.ts`), within this tail's slice; nothing due is two
        // indexed reads. Only where a cap is a number: an unmetered account shows no estimate, so
        // nothing is counted for it.
        run: async (accountId) => {
          // MIXED: the cap is the entitlements program's answer, through the resolver's cache.
          await scope.runTailStage("cycle.storageStatsPass", "mixed", async () => {
            if (typeof (await scope.storageCapFor(accountId)) !== "number") return;
            const { taken, mailboxes, more } = await storageStatsPass(scope.forAccount(accountId).db as unknown as Tx, {
              accountId, now: new Date(), until: sliceUntil(),
            });
            if (mailboxes > 0) scope.log.info("storage_stats_pass", { accountId, reason: taken, mailboxes, more });
          }, (err) => {
            scope.log.warn("storage_stats_failed", {
              accountId, err,
              reason: "one statement failed and nothing partial was written; the rows stand, and the " +
                "account resumes at the same place half an hour on",
            });
          });
        },
      },
      screener_correspondent_retro: {
        // ── NOBODY THIS ACCOUNT WROTE TO WAITS AT THE GATE ──────────────────────────────────
        //
        // Before the three Screener passes below, so a held correspondent is released rather than
        // bought a suggestion or acted on. Hourly per account: its evidence moves when somebody
        // writes, and the ingest already admits their new mail at once. Its own runner call.
        run: async (accountId) => {
          if (Date.now() - (scope.correspondentRetroAt.get(accountId) ?? 0) < CORRESPONDENT_RETRO_EVERY_MS) return;
          scope.correspondentRetroAt.set(accountId, Date.now());
          await scope.runTailStage("cycle.screenerCorrespondentRetroPass", "database",
            () => screenerCorrespondentRetroPass(scope.forAccount(accountId).db as unknown as Tx, { accountId, log: scope.log }), (err) => {
              scope.log.error("screener_correspondent_retro_failed", {
                accountId, err,
                reason: "each sender is released in its own transaction and nothing is marked, so the "
                  + "next hour re-reads the same evidence; new mail from them is admitted at ingest meanwhile",
              });
            });
        },
      },
      screener_auto_suggest: {
        // Buy the model's advice about incoming held senders. Its OWN runner call and loop. The ONLY
        // pass here that spends money, and the only thing in the product that
        // spends with no press in the same minute — three bounds hold it (the `auto_suggest_at`
        // watermark, a ten-sender page per account per cycle, and `spend()` before every model call with
        // the first refusal stopping the account). Off by default. It books the SAME `debit_classify`
        // reason ingest meters with (the `classify:screener:<message_id>` source is a real duplicate
        // check), but the `screener` ACTION — an exclusive claim and the screening-only setup grant first.
        run: async (accountId, walk) => {
          if (walk.suggestedAccounts.has(accountId)) return;
          // MIXED and untagged: the pass buys from the model and the entitlements program, and its
          // database calls carry no tag yet (a gap row names it).
          await scope.runTailStage("cycle.screenerAutoSuggestPass", "mixed", async () => {
            // The Ohbox bar, so a suggestion bought here asks the same question a user-pressed one
            // does. Read through the same 30-second cache the sync loop fills for every served
            // account, so this is a hit rather than a read per account per cycle.
            const screening = await scope.screeningFor(accountId);
            const { ran, bought, chargedAttempts, stopped: why, capped } = await screenerAutoSuggestPass(
              scope.forAccount(accountId).db as unknown as Tx,
              {
                accountId, log: scope.log, until: sliceUntil(),
                noteFault: scope.tailFaultNote("cycle.screenerAutoSuggestPass"),
                // No mailbox, deliberately: this pass spends through `spend`, never the circuit's
                // meter, so it has no open charge to clear or refund (`ClassifierCircuit.port`).
                classifier: scope.classifierCircuit?.port(),
                ...(scope.spend ? { credits: scope.spend, access: scope.spend } : { unmeteredLearning: true as const }),
                ...(scope.obligations ? { obligations: scope.obligations } : {}),
                ...(scope.usageRelay ? { usageHook: scope.usageRelay.hook } : {}),
                ...(scope.usageBuffer ? { recordRewriteUsage: (line) => scope.usageBuffer?.push(line) } : {}),
                ...(screening.ohboxBar ? { ohboxBar: screening.ohboxBar } : {}),
              },
            );
            if (ran && (bought > 0 || why)) {
              scope.log.info("screener_auto_suggest_pass", { accountId, bought, chargedAttempts, stopped: why, capped });
            }
          }, (err) => {
            scope.log.error("screener_auto_suggest_failed", {
              accountId, err,
              reason: "stored suggestions drop out of the candidate query. New debits for unfinished " +
                "suggestions go through the refund path before the next cycle retries.",
            });
          });
        },
      },
      screener_auto_act: {
        // ── ACT ON THE STORED SUGGESTIONS, ON THE ACT'S OWN CONSENT ─────────────────────────
        //
        // The senders whose stored advice is a confident Spam or screen-out are filed through
        // `applyScreenerDecision`, the door a press uses; AFTER the suggest pass, so advice bought this
        // cycle is acted on this cycle. It never lets a sender in. The consent is the act's own.
        run: async (accountId) => {
          await scope.runTailStage("cycle.screenerAutoActPass", "database", async () => {
            const acted = await screenerAutoActPass(
              scope.forAccount(accountId).db as unknown as Tx, {
                accountId, log: scope.log, until: sliceUntil(), consent: screenerActConsentFrom(accountId),
                noteFault: scope.tailFaultNote("cycle.screenerAutoActPass"),
              }, new Date(),
            );
            if (acted.ran && (acted.filed > 0 || acted.failed > 0)) {
              scope.log.info("screener_auto_act_pass", {
                accountId, applied: acted.filed, failed: acted.failed, capped: acted.capped,
              });
            }
          }, (err) => {
            scope.log.error("screener_auto_act_failed", {
              accountId, err,
              reason: "no sender was filed past the failure and nothing is marked — a filed sender " +
                "leaves the Screener and stops being a candidate, so the next cycle resumes at the " +
                "next waiting sender and every one of them still carries its own Apply",
            });
          });
        },
      },
      html_words_backfill: {
        // ── OLDER HTML-ONLY LETTERS' WORDS (mail 0172) ─────────────────────────────────────
        // Store-only: a letter stored before ingest kept its html's words gets them as its text, with
        // its preview, search document and one delta; nothing is re-filed. One page per account under
        // the slice, a turn of the event loop between rows; the cursor is the resume point.
        enter: async () => {
          let owed: string[] = [];
          await scope.runTailStage("cycle.htmlWordsOwedAccounts", "database", async () => {
            owed = await htmlWordsOwedAccounts(scope.roster as unknown as Tx, {
              limit: HTML_WORDS_ACCOUNTS_PER_TAIL, shard: accountShardFilter(scope.selection, accounts.id), forAccount,
            });
          }, (err) => {
            scope.log.warn("html_words_owed_read_failed", {
              err, reason: "the accounts owed the html-words backfill could not be read; the next tail reads them again",
            });
          });
          return owed;
        },
        run: async (accountId) => {
          await scope.runTailStage("cycle.htmlWordsBackfillPass", "database", async () => {
            const r = await htmlWordsBackfillPass(scope.forAccount(accountId).db as unknown as Tx, {
              accountId, until: sliceUntil(), turn: () => new Promise<void>((resolve) => setImmediate(resolve)),
            });
            if (r.ran && (r.filled > 0 || r.marked)) {
              scope.log.info("html_words_backfill_pass", {
                accountId, scanned: r.scanned, written: r.filled, skipped: r.wordless, marked: r.marked,
              });
            }
          }, (err) => {
            scope.log.error("html_words_backfill_failed", {
              accountId, err,
              reason: "the page's writes rolled back with its cursor, so the next tail reads the same rows again",
            });
          });
        },
      },
      search_index_backfill: {
        // ── THE SEARCH DOCUMENTS THE STORE STILL OWES (mail 0125) ─────────────────────────
        // Store-only: built from stored text, html and headers, no mailbox read. Its list is the
        // accounts with living mail and no marker in the present shape, read here rather than taken from the snapshot:
        // an account whose only mailbox is disabled, or whose account is parked, never syncs and
        // was never indexed. Bounded per account (rounds × batch); a failure never fails the tail.
        enter: async () => {
          let owed: string[] = [];
          await scope.runTailStage("cycle.searchIndexOwedAccounts", "database", async () => {
            owed = await searchIndexOwedAccounts(scope.roster as unknown as Tx, {
              limit: SEARCH_INDEX_ACCOUNTS_PER_TAIL, shard: accountShardFilter(scope.selection, accounts.id), forAccount,
            });
          }, (err) => {
            scope.log.warn("search_index_owed_read_failed", {
              err, reason: "the accounts owed a search index could not be read; the next tail reads them again",
            });
          });
          return owed;
        },
        run: async (accountId) => {
          await scope.runTailStage("cycle.searchIndexBackfillPass", "database", async () => {
            const indexed = await searchIndexBackfillPass({ db: scope.forAccount(accountId).db as unknown as Tx, accountId });
            if (indexed.ran && indexed.written > 0) {
              scope.log.info("search_index_backfill_pass", {
                accountId, written: indexed.written, rounds: indexed.rounds, marked: indexed.marked,
              });
            }
          }, (err) => {
            scope.log.error("search_index_backfill_failed", {
              accountId, err,
              reason: "no marker was written, so the next tail resumes at the first message without a search document; search still reads those through the older columns",
            });
          });
        },
      },
      gone_letter_tidy: {
        // ── LETTERS THAT LEFT THE SERVER BEFORE THEIR WORDS WENT WITH THEM ───────────────────
        // Store-only: the repo's own scrub over this account's gone letters that still hold a
        // preview, a search document, a summary, a tracker's address or a whole header block.
        // Its list is the snapshot and the accounts read here: a parked account, or one whose only
        // mailbox is disconnected, never syncs and keeps its letters. Bounded per run under the slice
        // clock; an account a run found clean is not asked again in this process, so a settled tail
        // pays one list read.
        enter: async (served) => {
          let listed: readonly string[] = [];
          await scope.runTailStage("cycle.goneLetterTidyAccounts", "database", async () => {
            listed = await goneLetterTidyAccounts(scope.roster as unknown as Tx, { shard: accountShardFilter(scope.selection, accounts.id) });
          }, (err) => {
            scope.log.warn("gone_letter_tidy_accounts_read_failed", {
              err, reason: "the accounts that do not sync could not be read; this tail tidies the served ones and the next reads them again",
            });
          });
          return [...new Set([...served, ...listed])].filter((a) => !scope.goneLettersTidied.has(a));
        },
        run: async (accountId) => {
          if (scope.goneLettersTidied.has(accountId)) return;
          await scope.runTailStage("cycle.goneLetterTidyPass", "database", async () => {
            const r = await goneLetterTidyPass(scope.forAccount(accountId).db as unknown as Tx, accountId, { until: sliceUntil(), done: scope.goneLettersTidied });
            if (r.tidied > 0) scope.log.info("gone_letter_tidy_pass", { accountId, written: r.tidied, more: !r.done });
          }, (err) => {
            scope.log.error("gone_letter_tidy_failed", {
              accountId, err,
              reason: "each page is its own transaction and a tidied letter leaves the set, so the next tail goes on "
                + "with what is left; nothing a person sees reads these letters",
            });
          });
        },
      },
      mailbox_erasure: {
        // ── THE ERASURES PEOPLE ASKED FOR (mail 0126) ─────────────────────────────────────
        //
        // "Remove and erase" stamps the mailbox and answers; this is the sweep it promised, every
        // cycle because somebody is watching "Erasing — N messages left" count down. Bounded in
        // steps and wall clock inside the pass, one indexed read over the owed stamps when there is
        // nothing to do. Its OWN runner call: every step is its own transaction, so a failure leaves
        // what committed and the next cycle resumes from the stamp — never a cycle abort.
        shard: true,
        run: async () => {
          await scope.runTailStage("cycle.accountErasure", "mixed", async () => {
            const port = scope.spend;
            await accountErasurePass(scope.roster as unknown as Tx, scope.log, {
              now: () => new Date(), forAccount: maintenanceAccount, shardKey: maintenanceShardKey,
              shard: accountShardFilter(scope.selection, accounts.id),
              release: port ? (id) => port.releaseAccount(id) : undefined,
              throttleKeys: throttleKeysFor(scope.keyProvider),
              noteFault: scope.tailFaultNote("cycle.accountErasure"),
            });
          }, (err) => { scope.log.error("account_erasure_pass_failed", { err }); });
          await scope.runTailStage("cycle.mailboxErasurePass", "database", async () => {
            const erased = await mailboxErasurePass(scope.roster as unknown as Tx, {
              now: () => new Date(), shard: shardFilter(scope.selection),
              forAccount: maintenanceAccount, repairKey: maintenanceShardKey,
            });
            if (erased.steps > 0) {
              scope.log.info("mailbox_erasure_pass", {
                mailboxes: erased.mailboxes, steps: erased.steps, finished: erased.finished,
                messagesErased: erased.messagesErased,
              });
            }
          }, (err) => {
            scope.log.error("mailbox_erasure_failed", {
              err,
              reason: "the erasure steps that committed stand, each is one transaction, and the stamp " +
                "is the resume point, so the next cycle continues from what is left",
            });
          });
        },
      },
      global_maintenance: {
        // ── Global maintenance, leader-only and time-gated (~hourly) ────────────────────
        //
        // `idempotency_keys` rows are written by every mutation and read only by a retry, so
        // nothing ever revisits them: without a sweep the table grows for the lifetime of the
        // deployment. `expires_at` is a 24-hour promise the API now ENFORCES on lookup, and this
        // is the other half — the rows actually going away. It belongs here rather than in a
        // platform cron because the worker is already the single elected writer, so exactly one
        // process runs it, and a failure is a logged warning, never a cycle abort.
        shard: true,
        gate: scope.maintenanceDue,
        run: async () => {
          await scope.runTailStage("cycle.pruneIdempotencyKeys", "database", async () => {
            const pruned = await pruneIdempotencyKeys(scope.roster as unknown as Tx, new Date());
            if (pruned > 0) scope.log.info("idempotency_pruned", { pruned });
          }, (err) => { scope.log.error("idempotency_prune_failed", { err }); });
          // An erased account's token hashes (cloud 0043) answer nothing past their own expiry;
          // the erasure writes them and nothing else ever revisits them, so they go here.
          await scope.runTailStage("cycle.pruneErasedBearers", "database", async () => {
            const pruned = await pruneErasedBearers(scope.roster as unknown as Tx, new Date());
            if (pruned > 0) scope.log.info("erased_bearers_pruned", { pruned });
          }, (err) => { scope.log.error("erased_bearers_prune_failed", { err }); });
          // An erased account's notice rows (cloud 0052): the warning a retention erasure keeps goes
          // ten years after the erasure, the billing record's period; nothing else deletes it.
          await scope.runTailStage("cycle.pruneErasedNotices", "database", async () => {
            const pruned = await pruneErasedNotices(scope.roster as unknown as Tx, new Date());
            if (pruned > 0) scope.log.info("erased_notices_pruned", { pruned });
          }, (err) => { scope.log.error("erased_notices_prune_failed", { err }); });
          // Sign-in throttle rows past retention (48 h; a known client 90 d). The API writes them and
          // only an erasure deleted them, so every typed address and client hash stayed for ever.
          await scope.runTailStage("cycle.pruneAuthThrottle", "database", async () => {
            const pruned = await pruneAuthThrottle(scope.roster as unknown as Tx, new Date());
            if (pruned > 0) scope.log.info("auth_throttle_pruned", { pruned });
          }, (err) => { scope.log.error("auth_throttle_prune_failed", { err }); });
          // ── WHAT WE OWE PEOPLE WHOSE SPEND BOUGHT NOTHING ─────────────────────────────────
          // The obligation rows cloud 0036 holds, turned back into credits. On the maintenance
          // cadence rather than per account: a debt belongs to an ACCOUNT, and the claim statement
          // reads the whole table once, so a per-account version would be one query per served
          // account to find, almost always, nothing. Leader-only; the row's own lease makes that a
          // performance property rather than a correctness one. NEVER THROWS by contract — the
          // pass states why where it is implemented.
          await refundObligationDrainPass(scope.roster as unknown as Tx, {
            ...(scope.spend ? { credits: scope.spend } : {}), log: scope.log, forAccount: maintenanceAccount,
          });
          // ── SPENT SEND-CONTENT CLAIMS ──────────────────────────────────────────────────
          //
          // HYGIENE, and it is worth saying plainly because the neighbouring sweep above is not:
          // no send's answer depends on this running. The window inside which an identical message
          // is refused is compared against the request clock in the send path, so a claim this
          // deletes had already stopped refusing anything. That is deliberate — a standalone
          // install runs the same send path and has no maintenance pass at all, so an expiry that
          // depended on pruning would be unbounded on every desktop.
          await scope.runTailStage("cycle.pruneSendFingerprints", "database", async () => {
            const fps = await pruneWorkerSendFingerprints(scope.roster as unknown as Tx, new Date(), {
              forAccount: maintenanceAccount, shardKey: maintenanceShardKey,
              shard: accountShardFilter(scope.selection, outboundSendFingerprints.accountId),
            });
            if (fps > 0) scope.log.info("send_fingerprints_pruned", { pruned: fps });
          }, (err) => { scope.log.error("send_fingerprint_prune_failed", { err }); });
          // Expired staged attachment bytes: the object, then the row. A hosted send puts attachment
          // bytes in a private bucket and references them; the row carries a 24-hour `expires_at` and
          // this is the half that makes that a fact. Same slot as the prune above (the worker is the
          // single elected writer). The abandoned upload is the case that matters — a ticket minted, a
          // compose window closed, no object written — and `remove` treats a storage 404 as success so
          // that row goes (reading it as failure would keep every abandoned ticket for the deployment's
          // life). It DRAINS: this took ONE 200-row page per hourly slot, which any faster account
          // outran, starving cleanup for everyone; `sweepExpiredStagingFor` now pages until empty under a
          // row ceiling and wall-clock budget. `drained: false` is a WARNING even though nothing threw —
          // a clean-looking number over a growing bucket is exactly what went wrong before.
          if (stagingStorage) {
            // MIXED and untagged: object storage and our database inside one `packages/db` call.
            await scope.runTailStage("cycle.sweepExpiredStaging", "mixed", async () => {
              const sweep = await sweepExpiredStagingFor(scope.roster as unknown as Tx, stagingStorage, new Date());
              if (sweep.deleted > 0 || sweep.pages > 0) {
                scope.log.info("attachment_staging_swept", {
                  swept: sweep.deleted, pages: sweep.pages, drained: sweep.drained,
                  stoppedBy: sweep.stoppedBy, failedPages: sweep.failedPages,
                });
              }
              if (!sweep.drained && sweep.pages > 0) {
                scope.log.warn("attachment_staging_backlog", {
                  swept: sweep.deleted, pages: sweep.pages,
                  stoppedBy: sweep.stoppedBy, failedPages: sweep.failedPages,
                  reason: sweep.failedPages > 0
                    ? "object storage refused at least one delete; those rows keep their objects and " +
                      "the next pass retries them, and the drain paged past them so nothing behind " +
                      "them is stalled"
                    : "the pass hit its per-invocation bound with rows still expired; the next pass " +
                      "resumes from the oldest of them. Sustained, this means the ceiling is below " +
                      "what this deployment produces and wants raising",
                });
              }
            }, (err) => {
              scope.log.error("attachment_staging_sweep_failed", {
                err,
                reason: "the rows stay and the next maintenance pass retries — objects are deleted " +
                  "before their rows, so nothing is orphaned by a failure here",
              });
            });
            /* AND THE OBJECTS NO TICKET NAMES — the half the sweep above cannot reach.
             *
             * That one works from tickets, so the one thing it can never see is an object whose
             * ticket is gone: a signed upload grant outlives the erasure that expired its ticket
             * and the sweep that removed its object, and the bytes it writes afterwards sit in the
             * bucket with nothing anywhere pointing at them. This walks the bucket instead and
             * deletes what no ticket names, bounded by age so it cannot race a live mint. Same
             * slot, after the expiry sweep: an object the sweep just removed is not a candidate,
             * and one whose row the sweep just deleted is younger than the age bound anyway.
             * COUNTS ONLY in the log — an object path names an account and a ticket. */
            await scope.runTailStage("cycle.reconcileStagingOrphans", "mixed", async () => {
              const rec = await reconcileStagingOrphansFor(
                scope.roster as unknown as Tx, stagingStorage, new Date());
              if (rec.orphans > 0 || rec.unrecognised > 0 || !rec.complete) {
                scope.log.info("attachment_staging_reconciled", {
                  scanned: rec.scanned, orphans: rec.orphans, deleted: rec.deleted,
                  unrecognised: rec.unrecognised, pages: rec.pages,
                  stoppedBy: rec.stoppedBy, complete: rec.complete,
                });
              }
              if (rec.unrecognised > 0) {
                scope.log.warn("attachment_staging_foreign_objects", {
                  unrecognised: rec.unrecognised,
                  reason: "objects in the staging bucket whose path is not one this deployment " +
                    "writes. Counted and left alone: this bucket is supposed to hold nothing else",
                });
              }
            }, (err) => {
              if (err instanceof StagingListingUnsupportedError) {
                scope.log.warn("attachment_staging_reconcile_unsupported", {
                  reason: "this storage cannot list its bucket, so an object whose ticket is gone " +
                    "can never be found; the expiry sweep alone cannot promise an empty bucket",
                });
              } else {
                scope.log.error("attachment_staging_reconcile_failed", {
                  err,
                  reason: "nothing was deleted and nothing was recorded as deleted; the next " +
                    "maintenance pass walks the bucket again from the start",
                });
              }
            });
          } else {
            scope.log.info("attachment_staging_sweep_skipped", {
              reason: "no staging bucket is configured on this worker; if the API stages, its " +
                "bucket is not being swept",
            });
          }

          // ── RETENTION — change_log compaction plus the audit_log / auth_events fixed-age
          // prunes. Same slot as its neighbours (the worker is the single elected writer, and a
          // failure is a logged warning, never a cycle abort — the pass states that itself). The
          // horizons live in ONE place, `@trafficflow/db/cloud`'s `retention.ts`.
          await retentionPrunePass(scope.roster as unknown as Tx, new Date(), scope.log, {
            forAccount: maintenanceAccount, shard: accountShardFilter(scope.selection, accounts.id),
            shardKey: maintenanceShardKey,
          });
          // Sign-in records, sessions and the ceremony tables, 30 days past their end; its own
          // deadline, never a throw (`retention-prune.ts`).
          await signInRetentionPass(scope.roster as unknown as Tx, new Date(), scope.log, {
            forAccount: maintenanceAccount, shard: (column) => accountShardFilter(scope.selection, column),
            shardKey: maintenanceShardKey,
          });
        },
      },
    };
    // END TAIL_IMPL
    const TAIL_SECTIONS: readonly TailSection[] =
      TAIL_SECTION_PLAN.map((p) => ({ name: p.name, ...TAIL_IMPL[p.name] }));

    function kickTail(): void {
      if (scope.stopped || scope.tailQueued) return;
      scope.tailQueued = true;
      void scope.serialize(async () => { scope.tailQueued = false; await cycleTail(); }).catch((err: unknown) => {
        if (isSharedDatabaseFault(err)) scope.noteDatabaseFault(err);
        scope.log.error("cycle_tail_failed_unexpectedly", { err });
      });
    }

    /** One turn of the walk. Never throws past a slice: a failed slice is logged and passed. */
    async function cycleTail(): Promise<void> {
      if (scope.stopped) return;
      const turnStarted = Date.now();
      if (scope.tailWalk === null) {
        const mailboxesNow = await tailSnapshot();
        scope.tailWalk = {
          mailboxes: mailboxesNow, accounts: accountsOf(mailboxesNow), suggestedAccounts: new Set(), section: 0, list: null, index: 0,
          rotationMs: scope.lastRotationMs ?? 0, dueRevisits: scope.lastDueRevisits, startedAt: turnStarted, workMs: 0, turns: 0,
          sectionMs: TAIL_SECTIONS.map(() => 0),
        };
      }
      const walk = scope.tailWalk;
      walk.turns++;
      const clockIn = (at: number): void => { walk.sectionMs[walk.section]! += Date.now() - at; };
      try {
        for (; walk.section < TAIL_SECTIONS.length; walk.section++, walk.list = null) {
          const s = TAIL_SECTIONS[walk.section]!;
          if (walk.list === null) {
            if (s.gate && !s.gate()) continue;
            const at = Date.now();
            walk.list = s.shard ? [""] : s.enter ? await s.enter(walk.accounts) : walk.accounts;
            walk.index = 0;
            clockIn(at);
          }
          for (; walk.index < walk.list.length; walk.index++) {
            if (scope.stopped) return;
            // THE ONLY YIELD POINTS. A wake ahead of the rest of the walk once the floor has run; a
            // poll cycle does not preempt (it would starve the walk to one slice per rotation).
            const elapsed = Date.now() - turnStarted;
            const woken = elapsed >= tailTurn.minTurnMs && anyWoken();
            if (woken || elapsed >= tailTurn.turnBudgetMs) {
              if (woken) scope.kickCycle();
              kickTail();
              return;
            }
            await scope.config.tailSliceHook?.(s.name, walk.index);
            const at = Date.now();
            await scope.runTailStage(`cycle.tail.${s.name}`, "mixed", () => s.run(walk.list![walk.index]!, walk), (err) => {
              scope.log.error("cycle_tail_section_failed", {
                section: s.name, err,
                reason: "this slice's pass threw past its own handling; the walk goes on to the next " +
                  "slice, and the pass's own resume point is the next walk's",
              });
            });
            clockIn(at);
          }
        }
      } finally {
        walk.workMs += Date.now() - turnStarted;
      }
      // THE WALK IS OVER: one line with where its time went, and the next rotation starts a new one.
      scope.tailWalk = null;
      scope.lastTailMs = walk.workMs;
      scope.log.info("cycle_phases", {
        rotationMs: walk.rotationMs, dueRevisits: walk.dueRevisits, tailMs: walk.workMs, tailWallMs: Date.now() - walk.startedAt,
        turns: walk.turns,
        sections: TAIL_SECTIONS.map((s, i) => ({ section: s.name, ms: walk.sectionMs[i]! })),
      });
    }

    /** Where the walk is, for `/health` — an index, never an account id. */
    function tailPosition(): { section: string; account: number; of: number } | null {
      const w = scope.tailWalk;
      if (w === null || w.section >= TAIL_SECTIONS.length) return null;
      return { section: TAIL_SECTIONS[w.section]!.name, account: w.index, of: (w.list ?? w.accounts).length };
    }

    // The thread backfill, behind the cycle and bounded. What the first version got wrong was
    // placement, not the pass: it ran to exhaustion on the attach seam, in front of a live IMAP
    // connection, and killed the process. Four properties replace it, each a guard in
    // `thread-backfill-placement.e2e.test.ts`: 1. attach never waits for it (there is no call on that
    // path — a stronger statement than "it is fast"); 2. it is a SEPARATE queue entry, not the tail of
    // `cycle()`, so it runs after the cycle reported and deliberately does NOT touch `lastCycleAt` or
    // `beat()` — freshness it did not earn is the lie /health was fixed to stop telling; 3. bounded by
    // pages AND wall clock (resuming is free — the predicate is `thread_id IS NULL`); 4. it cannot
    // throw into anything (an escaping rejection becomes `exit(1)`). PACING: one slice per completed
    // cycle, NO self re-kick — a `setMessageThread` regression would otherwise pin the CPU.

    /** One slice at a time on the queue, the same dedupe `kickCycle` uses. */
    scope.backfillQueued = false;
    /**
     * Round-robin over `dutyAccounts`, so a shard with many accounts spends the same budget
     * per cycle and no account can be starved by a larger one. Read MODULO the current length:
     * `reconcileRoster` reassigns the list, and an index captured against an older, longer one
     * would address `undefined` and run a slice for no account at all.
     */
    scope.backfillCursor = 0;
    const threadBackfill = scope.config.threadBackfill ?? runThreadBackfill;

    async function threadBackfillSlice(): Promise<void> {
      if (scope.stopped || scope.dutyAccounts.length === 0) return;
      const accountId = scope.dutyAccounts[scope.backfillCursor % scope.dutyAccounts.length]!;
      scope.backfillCursor++;
      try {
        const r = await threadBackfill({
          repo: scope.forAccount(accountId).repo, accountId, log: scope.log,
          maxPages: THREAD_BACKFILL_SLICE_PAGES,
          deadlineMs: THREAD_BACKFILL_SLICE_MS,
        });
        if (r.resolved > 0) {
          scope.log.info("thread_backfill_slice", {
            accountId, resolved: r.resolved, threadsCreated: r.threadsCreated, more: r.truncated,
          });
        }
      } catch (err) {
        // The whole point of the slice. A failure here is unthreaded mail — mail that reads as
        // singletons, not mail that is lost — and it must cost the cycle nothing. Nothing is
        // marked, so the next slice resumes from wherever `thread_id IS NULL` now starts.
        scope.log.error("thread_backfill_failed", {
          accountId, err,
          reason: "the backlog is identified by `thread_id IS NULL` rather than by a marker, " +
            "so the next slice resumes it",
        });
      }
    }

    function kickThreadBackfill(): void {
      if (scope.stopped || scope.backfillQueued) return;
      scope.backfillQueued = true;
      void scope.serialize(async () => {
        scope.backfillQueued = false;
        await threadBackfillSlice();
      }).catch((err: unknown) => {
        // Unreachable while `threadBackfillSlice` catches everything, and kept precisely
        // because that is a property of today's body rather than of the queue. An escaping
        // rejection here is an `unhandledRejection`, and this process exits on those.
        scope.log.error("thread_backfill_slice_failed_unexpectedly", { err });
      });
    }
    scope.kickTail = kickTail;
    scope.tailPosition = tailPosition;
    scope.kickThreadBackfill = kickThreadBackfill;
}
