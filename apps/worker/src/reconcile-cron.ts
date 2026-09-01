import { makeOwnedDb, writeHeartbeat, clearHeartbeat } from "@trafficflow/db/cloud";
import { closeStoodDownAppointments, type Tx } from "@trafficflow/db";
import { providerAuthservIds, silentLogger, type Logger } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { instanceIdFrom, selectionOf, type WorkerConfig } from "./config.js";
import { acquireLeaderLock, leaderLockKeyFor } from "./leader-lock.js";
import {
  accountInShard, clearOrganizerStandDown, loadMailboxById, makeSyncWriteFence,
  markMailboxStoodDown, stampMailboxSyncNow, type LeaderFence,
} from "./mailboxes.js";
import { LeaderFencedError, runSyncCycle, type SyncDeps } from "./sync.js";
import { OrganizerProfileSync } from "./profile.js";
import { makeStorageCapResolver } from "./storage-cap.js";
import {
  CLOUD_DISPLAY_NAME, LeaseUnavailableError, OrganizerStandDownError, acquireLeasePermit,
  cloudInstallId, type LeasePermit,
} from "./lease.js";
import { isCliEntry } from "./entry.js";
import { cronEvent, runCronCli } from "./cron-log.js";

/**
 * WHO THE BACKSTOP IS, IN `worker_heartbeats` — and it is deliberately NOT the always-on
 * worker's identity.
 *
 * The heartbeat row is keyed on `shard_index` alone (it is the PRIMARY KEY), so there is exactly
 * one row per shard and "this row names me" is the same statement as "nobody has taken this shard
 * from me". That is what {@link makeSyncWriteFence} keys on, and it is why claiming the row is
 * what makes the fence below REAL rather than decorative.
 *
 * The prefix keeps two processes that could otherwise share an id apart. `instanceIdFrom()` reads
 * `RAILWAY_REPLICA_ID` first, and a deployment that ran the backstop inside the worker's own
 * service would hand both the same string — at which point a successor worker's claiming write
 * would leave the backstop's fence still matching, and the fence would pass in exactly the
 * handover it exists to refuse. A literal prefix makes that collision unrepresentable instead of
 * unlikely.
 *
 * It also answers the question `CRON_SERVICE = "worker-cron"` exists to answer — *is the loop
 * running, or is only the backstop running?* — on the row an operator reads first: `worker_down`'s
 * detail line quotes `instance_id`, so a shard being carried by the backstop says so by name.
 */
const RECONCILE_INSTANCE_PREFIX = "reconcile-cron";

/**
 * Correctness backstop. Acquires the shard's leader lock: if the always-on worker holds it,
 * the live worker is already reconciling each cycle, so this run exits ({ ran: false }).
 * Otherwise it performs one full sweep (two cycles → convergence) and releases. Never runs
 * concurrently with the worker.
 *
 * It remains the single-mailbox env backstop (the always-on startWorker moved to
 * DB creds, multi-mailbox and multi-ACCOUNT; this did not), so it requires the explicit env
 * mailbox + its account. Two things are now VERIFIED rather than trusted:
 *
 *  • the configured `TF_ACCOUNT_ID` really owns `TF_MAILBOX_ID` (otherwise the sweep would
 *    write another account's rows under the configured account id);
 *  • that account belongs to THIS process's shard. The lock is shard-specific, so a shard-1
 *    cron pointed at a shard-0 mailbox would sweep it while shard 0's worker holds a
 *    different lock and believes it is the only writer.
 *
 * ── THE TWO DISCIPLINES THIS PASS USED TO SKIP, AND WHY THE SHARD LOCK IS NOT EITHER OF THEM ──
 *
 * The lock this pass takes coordinates CLOUD WORKERS WITH EACH OTHER. It says nothing about the
 * two things that decide whether this process may write to a customer's mailbox at all, and until
 * this file ran them it went from `acquireLeaderLock` straight to `ensureFolders()` and two
 * `runSyncCycle` calls:
 *
 *  1. **THE ORGANIZER LEASE.** Exactly one active organizer per mailbox, enforced by a lease in
 *     `ohmail/_meta` — the mailbox is the only medium a LOCAL install and Cloud
 *     share. The shard lock is invisible to a desktop install, so a backstop
 *     that consulted only the lock would organize a mailbox its owner had moved to their own
 *     machine: both sides ingesting, both adopting state, and a message the user files on the
 *     desktop inside this pass's plan→write window reverted by this pass's stale desired state.
 *     **No infrastructure failure is required** — it is the ordinary dual-mode configuration.
 *     So the gate runs here at the seam `index.ts` runs it at on `attach`: after `connect()` and
 *     BEFORE `ensureFolders()`, because `ensureFolders` already writes (it creates the `ohmail/*`
 *     tree in somebody else's mailbox).
 *
 *     RE-ASKED AT EVERY WRITE BOUNDARY THIS PASS OWNS, through a {@link LeasePermit}. It read the
 *     lease ONCE per run until 2026-09-01, under a note here arguing that was "not a weakening"
 *     because "this process holds the shard lock for one bounded sweep and then exits". **The bound
 *     was the problem, and the shard lock is not the relevant one.** One sweep is `ensureFolders()`
 *     plus two full cycles over a whole mailbox, and the shard lock coordinates Cloud workers with
 *     each other — it is invisible to a desktop install, which is precisely the organizer this pass
 *     would be writing beside. See the block at `ensureFolders()` for the boundaries and for the
 *     residual (the writes inside one `runSyncCycle`, which the permit does not reach).
 *
 *  2. **THE LEADER FENCE.** `SyncDeps.fence` is a no-op when absent, and this pass built
 *     its `SyncDeps` without one while `LeaderLock.lost` — which exists precisely to expose the
 *     loss — had no consumer at all. The advisory lock is SESSION-scoped, so a failover, a network
 *     break or a `pg_terminate_backend` frees it the instant the connection drops; a standby then
 *     takes the shard and attaches the same mailbox while this pass is still inside `runSyncCycle`
 *     on its own pooled handle, writing and mutating with nothing to stop it. That is the exact
 *     split-brain sequence the fence exists to stop, surviving on the one path the fence fix did
 *     not thread it through.
 *
 *     The fix reuses the worker's mechanism rather than restating it: this pass CLAIMS the shard's
 *     heartbeat row while it holds the shard's lock (which is the documented precondition for
 *     `writeHeartbeat` — the row *is* "the leader of shard N"), hands
 *     {@link makeSyncWriteFence} that identity, and wires `() => lockLost` to `lock.lost` as the
 *     synchronous tripwire. A successor worker's own claiming write overwrites `instance_id`, and
 *     every later write of this sweep is then refused with nothing written. The claim is
 *     surrendered in the `finally` with `clearHeartbeat`, which is guarded on the instance id and
 *     therefore cannot clobber a successor's.
 *
 * ── WHAT THE LEASE GATE MUST NOT DO ──────────────────────────────────────────────────────────
 *
 * Neuter the pass. This is the recovery path for pending mutations when the always-on worker is
 * not running, so **a mailbox nobody organizes is exactly its ground** — and the decision table
 * already says so without help: an empty `ohmail/_meta` is arm 4 (`organize`), and this pass's own
 * older claim, however stale, is arm 3 (`organize` — *"continuing is not becoming"*). What changes
 * is only the case the invariant names: a mailbox a DESKTOP is renewing is arm 7, and this pass
 * now stands down on it instead of writing beside it.
 *
 * `log` defaults to `silentLogger` — see `cron-log.ts` for why the process that deploys is
 * the only one that turns it on.
 */
export async function runReconcileCron(
  config: WorkerConfig, log: Logger = silentLogger,
): Promise<{ ran: boolean; reason?: string }> {
  const shardIndex = config.shardIndex ?? 0;
  const lock = await acquireLeaderLock(config.databaseUrl, leaderLockKeyFor(shardIndex));
  if (!lock) return { ran: false, reason: "worker-live" };

  // THE SYNCHRONOUS TRIPWIRE, armed before anything can write. `lock.lost` resolves (never
  // rejects) the moment the dedicated session closes and does NOT resolve for a deliberate
  // `release()`, so this flag means "the lock is provably gone" and nothing else. The fence below
  // reads it before it opens a transaction and before every IMAP mutation, so an in-flight sweep
  // stops at its next write site instead of running out its batch beside the new leader.
  let lockLost = false;
  void lock.lost.then(() => { lockLost = true; });

  if (!config.imap || !config.mailboxId || !config.accountId) {
    await lock.release();
    throw new Error("reconcile-cron requires env IMAP creds + TF_MAILBOX_ID + TF_ACCOUNT_ID (single-mailbox backstop)");
  }
  const mailboxId = config.mailboxId;
  const accountId = config.accountId;

  const owned = makeOwnedDb(config.databaseUrl);
  const db = owned.db;
  const selection = selectionOf(config);

  // ONE cleanup path for every exit below. The pass grew from three early returns to seven when
  // the two gates above landed, and hand-rolled `await owned.close(); await lock.release();` at
  // each of them is how one of them eventually leaks a pooled connection or a lock.
  const fence: LeaderFence = {
    shardIndex,
    instanceId: `${RECONCILE_INSTANCE_PREFIX}:${config.instanceId ?? instanceIdFrom()}`,
  };
  let adapter: ImapAdapter | null = null;
  let claimedHeartbeat = false;
  try {
    const row = await loadMailboxById(db, mailboxId);
    if (!row || row.accountId !== accountId) {
      // NAME the two ids before throwing. The message below carries them, and `runCronCli`
      // reduces a thrown value to class + code, so without this line the operator gets
      // `errorClass: "Error"` and nothing to act on — which is the honest cost of an allowlist,
      // paid the way `log.ts`'s header prescribes: name the fact under a key already on the
      // census rather than smuggling the sentence out. `mailboxId` is what was CONFIGURED;
      // `accountId` is who actually owns it, which is the whole content of the mismatch.
      log.error(cronEvent("reconcile", "mailbox_mismatch"), {
        mailboxId, accountId: row?.accountId ?? null,
      });
      throw new Error(
        `reconcile-cron: TF_MAILBOX_ID ${mailboxId} ` +
        `${row ? `belongs to account ${row.accountId}, not TF_ACCOUNT_ID ${accountId}` : "does not exist"}`,
      );
    }
    if (!(await accountInShard(db, row.accountId, selection))) {
      log.info(cronEvent("reconcile", "other_shard"), {
        accountId: row.accountId, shard: selection.shardIndex ?? 0, shards: selection.shards ?? 1,
      });
      return { ran: false, reason: "other-shard" };
    }
    // THE ROSTER'S OWN PREDICATE, applied to the one mailbox this pass serves.
    // `loadEnabledMailboxes` selects `status <> 'disabled'`, so the always-on worker never
    // attaches a disabled mailbox; this pass took its mailbox from the environment and therefore
    // never asked. A `disabled` row is either the user's own disconnect — the most consequential
    // action on that screen — or a stand-down already recorded, and sweeping it would undo the
    // first and silently re-enter the second. Only the account's own PATCH re-enables a mailbox.
    if (row.status === "disabled") {
      log.info(cronEvent("reconcile", "mailbox_disabled"), {
        mailboxId, accountId: row.accountId, disabledReason: row.disabledReason,
      });
      return { ran: false, reason: "mailbox-disabled" };
    }

    // CLAIM THE SHARD, so the fence has a leadership record to be refused against. Written only
    // after every validation above has passed: a run that is about to return `other-shard` has no
    // business announcing itself as the shard's leader.
    await writeHeartbeat(db as unknown as Tx, {
      shardIndex, instanceId: fence.instanceId, shards: selection.shards ?? 1,
      // The backstop's duty is exactly its one configured mailbox and that mailbox's account, so
      // these are true about THIS process rather than about the shard's full roster. `lastCycleAt`
      // is null because nothing has synced yet — it is stamped by `stampMailboxSyncNow` below, on the
      // mailbox row, which is what `sync_lag` actually reads.
      mailboxes: 1, expected: 1, accounts: 1, quarantined: 0, degraded: false,
      lastCycleAt: null, startedAt: new Date(),
    });
    claimedHeartbeat = true;

    adapter = new ImapAdapter({
      host: config.imap.host, port: config.imap.port, secure: config.imap.secure,
      auth: { user: config.imap.user, pass: config.imap.pass }, sentDomain: config.sentDomain,
    });
    await adapter.connect();

    // ── THE ORGANIZER LEASE, BEFORE ANYTHING WRITES ──────────────────────────────────────────
    //
    // `LeaseUnavailableError` is exempted BY CLASS, exactly as it is at both of the worker's call
    // sites: "somebody else holds this" and "I could not look" must not be reachable from one
    // another (`ORGANIZER-LEASE-RESUME.md` §3.4). A lease we cannot read means we do not organize
    // and the mailbox is NOT recorded as stood down — there is nothing to record.
    /**
     * THE STAND-DOWN, AS A FUNCTION — because it is reached from FOUR places, not one.
     *
     * It began as the body of the acquisition's `catch`, which was correct while the lease was read
     * exactly once. It is not correct now: `permit.check()` re-runs the gate at three later write
     * boundaries and throws {@link OrganizerStandDownError} from any of them, and the only catch
     * downstream accepts `LeaderFencedError` and rethrows everything else. **A routine handover — a
     * user moving their mailbox to their own machine mid-sweep — would have exited this cron with a
     * thrown error instead of a recorded stand-down: no `markMailboxStoodDown`, no `"stood-down"`
     * result, an operator paged for the mechanism working, and the takeover stamp possibly already
     * cleared.** Found by the review round over the commit that introduced the later checks; the
     * regression was created by the fix, which is the argument for reviewing a fix.
     */
    const standDown = async (
      err: OrganizerStandDownError,
    ): Promise<{ ran: boolean; reason: string }> => {
      log.warn(cronEvent("reconcile", "organizer_stand_down"), {
        mailboxId, accountId: row.accountId,
        disabledReason: err.reason,
        // WHETHER THE OTHER ORGANIZER IS STILL RENEWING — `held` is a live foreign claim,
        // `stopped` is one nobody has renewed since. Same two incidents, same `disabled_reason`.
        // `state` and not `organizerState`: `ALLOWED_FIELDS` carries the former.
        state: err.state,
        heldBy: err.heldBy,
        reason: "another organizer holds this mailbox; this sweep stops here and mutates nothing " +
          "further — exactly one active organizer per mailbox is the invariant this enforces",
      });
      // The durable half, through the SAME fenced lifecycle write the worker's stand-down uses.
      // A fenced-out write still stands the mailbox down IN THIS PROCESS: the decision not to
      // organize is ours and is not contingent on recording it.
      try {
        const written = await markMailboxStoodDown(db, mailboxId, err.reason, { fence });
        if (!written) {
          log.info(cronEvent("reconcile", "stand_down_write_fenced"), {
            mailboxId, accountId: row.accountId,
            reason: "the mailbox is already disabled or this process no longer leads the shard",
          });
        }
      } catch (writeErr) {
        log.error(cronEvent("reconcile", "stand_down_write_failed"), {
          mailboxId, accountId: row.accountId, err: writeErr,
          reason: "this sweep organizes nothing further regardless; the row could not record why",
        });
      }
      // ── AND THE APPOINTMENTS THIS SWEEP CAN NO LONGER KEEP ARE CLOSED WITH A SENTENCE ──────
      //
      // The same call the always-on worker's gate makes, for the same reason: a pending scheduled
      // send does not travel (the portable profile carries configuration and deliberately no
      // drafts), and the mailbox leaves the roster from here. Reached from all FOUR of this
      // function's callers because it is inside `standDown` — which is the whole argument for
      // this function existing; see its header.
      //
      // Best-effort, like the write above it: standing down is already decided and may not be
      // made contingent on a second write, and the hosted scheduled-send pass refuses a
      // `disabled` mailbox at due time and closes the row itself. Unfenced for the reason the
      // worker's twin gives in full: the fence arbitrates Cloud against Cloud, while this write
      // is justified by the LEASE — a fact about `ohmail/_meta` every instance reads the same way
      // — and a close gated on the fenced write would never run for a mailbox that is already
      // `disabled`, which is the population that needs it most.
      try {
        const closed = await closeStoodDownAppointments(db as unknown as Tx, {
          accountId: row.accountId, mailboxId, reason: err.reason, now: new Date(),
        });
        if (closed.closed > 0) {
          log.warn(cronEvent("reconcile", "scheduled_sends_stood_down"), {
            mailboxId, accountId: row.accountId, closed: closed.closed,
            disabledReason: err.reason,
            reason: "these scheduled sends were made by this organizer and cannot travel; each " +
              "is now an ordinary draft carrying the sentence its Drafts row quotes",
          });
        }
      } catch (closeErr) {
        log.error(cronEvent("reconcile", "scheduled_sends_stand_down_failed"), {
          mailboxId, accountId: row.accountId, err: closeErr,
          reason: "a scheduled send this organizer can no longer make was not closed with its " +
            "sentence; the hosted pass refuses a disabled mailbox at due time and closes it there",
        });
      }
      return { ran: false, reason: "stood-down" };
    };

    let permit: LeasePermit;
    try {
      permit = await acquireLeasePermit({
        adapter,
        self: {
          // The SAME identity the always-on worker claims with — a per-process id here would make
          // every backstop run look like a new organizer arriving and stand the worker down. See
          // the block above `cloudInstallId`.
          installId: config.organizer?.installId ?? cloudInstallId(config.environment ?? "production"),
          kind: "cloud",
          displayName: config.organizer?.displayName ?? CLOUD_DISPLAY_NAME,
          // A fresh process trusts its own install id exactly once; that is what keeps own-role
          // resumption working, and it is the whole reason this pass can recover a mailbox whose
          // Cloud claim has gone stale.
          lastNonce: null,
        },
        // A FUNCTION, not an instant. The permit re-reads past its TTL and needs the clock at the
        // moment it asks, not the clock at the moment this pass started.
        now: () => new Date(),
        takeover: row.takeoverAuthorizedAt ? "authorized" : "none",
        ...(config.organizer?.staleAfterMs !== undefined ? { staleAfterMs: config.organizer.staleAfterMs } : {}),
        log: (event, detail) => { log.info(event, { ...detail, mailboxId, accountId: row.accountId }); },
      });
    } catch (err) {
      if (err instanceof OrganizerStandDownError) return await standDown(err);
      if (!(err instanceof LeaseUnavailableError)) throw err;
      log.warn(cronEvent("reconcile", "lease_unreadable"), {
        mailboxId, accountId: row.accountId, err,
        reason: "the organizer lease could not be read, so this sweep organizes nothing — " +
          "an unreadable lease is not a stand-down and is not the mailbox's fault",
      });
      return { ran: false, reason: "lease-unreadable" };
    }

    // ONE-SHOT, as at `index.ts#mayOrganize`. The authorization bought this becoming and no
    // other; leaving it set would let a lapse-then-resubscribe seize the mailbox back months
    // later from whatever a human deliberately moved it to. Best-effort: the gate already said
    // organize and the claim is already written, so failing to spend the stamp costs one more
    // run of it being spendable, never correctness.
    if (row.takeoverAuthorizedAt || row.disabledReason) {
      try {
        await clearOrganizerStandDown(db, mailboxId, { fence });
      } catch (err) {
        log.warn(cronEvent("reconcile", "takeover_clear_failed"), {
          mailboxId, accountId: row.accountId, err,
        });
      }
    }

    // ── EVERY WRITE BOUNDARY THIS PASS OWNS, RE-ASKED ─────────────────────────────────────────
    //
    // This pass used to read the lease ONCE and then write for a whole sweep, and the comment at the
    // top of this file defended it: *"ONCE per run, not once per cycle, and that is not a weakening:
    // … This process holds the shard lock for one bounded sweep and then exits."* **The bound was the
    // problem.** "One bounded sweep" is `ensureFolders()` plus TWO full `runSyncCycle` calls over a
    // whole mailbox — minutes on a large one — and a takeover landing anywhere inside it was
    // unobserved until the process exited. The shard lock does not help: it coordinates Cloud workers
    // with each other and is invisible to a desktop install, which is the organizer this pass would
    // be writing beside.
    //
    // So the lease read carries a deadline (`LeasePermit`) and is asked at each boundary this pass
    // controls: here, before `ensureFolders()` CREATEs anything, and before each cycle. Inside the
    // TTL the ask is a comparison; past it, one `runLeaseGate` — which also RENEWS, so a long sweep
    // keeps its own claim fresh instead of ageing into staleness while it works. A stand-down throws
    // and the `catch` below reports it as the handover it is.
    //
    // WHAT THIS DOES NOT BOUND, because the honest bound is worth more than a tidy claim: the writes
    // INSIDE a `runSyncCycle` are gated by that cycle's own leader fence and not by this permit, so
    // the residual window is one cycle rather than one sweep. Closing it means threading the
    // organizer lease through `SyncDeps` alongside the leader fence — the same seam the always-on
    // worker needs and does not have either. Ledgered as one row for both callers rather than fixed
    // halfway here.
    // This one needs its own arm: the two cycle checks below sit inside the `runSyncCycle` try,
    // which now routes a stand-down to `standDown`, but this call is above it and would otherwise
    // propagate — the same regression, one boundary earlier and just as invisible.
    try {
      await permit.check();
    } catch (err) {
      if (err instanceof OrganizerStandDownError) return await standDown(err);
      throw err;
    }
    await adapter.ensureFolders();
    // ── THE IMPORT HOLD, ARMED FROM THE MAILBOX ITSELF (TAKEOVER-RESCREEN, rounds 4 and 6) ────
    //
    // This pass runs precisely when no worker leads, so the in-memory hold died with the worker
    // that held it — and this pass EXECUTES authorized takeovers (the `takeover:` arm above), so
    // it can be the FIRST organizer a travelling document ever meets, with no durable marker yet
    // for a database-only predicate to read. The same preflight as the worker's attach and the
    // sidecar's drain: read `ohmail/_meta`, arm on a found-foreign-different (or newer) document,
    // write the marker the confirm surface needs, reconcile a stale one (`lapseStaleMarker`).
    // Read-only against the mailbox; the write-behind stays the always-on worker's — this pass
    // never calls `onOrganize`.
    const profileSync = new OrganizerProfileSync({
      db: db as unknown as Tx, accountId, mailboxId, adapter,
      self: {
        installId: config.organizer?.installId ?? cloudInstallId(config.environment ?? "production"),
        kind: "cloud",
      },
      producerVersion: config.buildVersion ?? "dev",
      log: (event, detail) => {
        if (/_failed$/.test(event)) log.warn(event, { ...detail });
        else log.info(event, { ...detail });
      },
    });
    await profileSync.armHoldFromFolder();
    const deps: SyncDeps = {
      repo: makeDrizzleRepo(db), adapter, accountId, mailboxId,
      // The same host string the adapter above dials names whose report may be believed.
      trustedAuthservIds: providerAuthservIds(config.imap.host),
      // METERED, like the loop this pass stands in for: the backstop ingests the same mail the
      // worker would have, so it consults the same subscription-derived cap — read once here and
      // held on these deps for the sweep's two cycles.
      storageCap: await makeStorageCapResolver(db as unknown as Tx, log)(accountId),
      // The leader fence, on this path too. Same builder, same shard-leadership definition, same
      // synchronous tripwire — see the block at the top of this file.
      fence: makeSyncWriteFence(db, mailboxId, fence, () => lockLost),
      // ── NO `knownSet`, AND THAT IS A RULING RATHER THAN AN OMISSION ────────────────────────
      //
      // The known-set memo (`known-set.ts`) is worth having because the hosted worker re-reads the
      // same set once per poll interval for the life of an attachment. This sweep is the opposite
      // shape: it takes the mailbox for two cycles and gives it back, so a memo could save at most
      // ONE of the two reads — and it would buy that by holding an in-memory copy of a mailbox's
      // known UIDs across a boundary this pass exists to respect. This sweep runs precisely when
      // no worker leads, and it stands down the moment one does. A cold read per sweep is cheaper
      // to reason about than a memo whose whole safety argument is about who holds the mailbox.
    };
    try {
      // The hold is EVALUATED from the current facts before each pass — never cached (see
      // `importDecisionOpenNow`): an answer landing between the preflight and the first pass,
      // or while the first pass drains a large batch, must not leave a pass adopting strangers
      // under a question that has closed — and a document this pass itself just took over (the
      // cron executes authorized takeovers) is seen by the evaluation, marker or no marker. A
      // faulted read costs one stale cycle, retried at the second pass.
      await permit.check();
      await runSyncCycle({ ...deps, importDecisionOpen: await profileSync.importDecisionOpenNow() });
      // The second cycle is where the once-per-run read was weakest: the FIRST cycle has just spent
      // however long it took draining a mailbox, so this is the ask most likely to find the lease
      // actually gone rather than to be served from the receipt.
      await permit.check();
      await runSyncCycle({ ...deps, importDecisionOpen: await profileSync.importDecisionOpenNow() });
    } catch (err) {
      // THE ORGANIZER handover, from any of the three `permit.check()` calls above. Same shape as
      // the leader handover below and for the same reason — it is the mechanism working, not a
      // fault — but a DIFFERENT question, so it is answered by the same `standDown` the acquisition
      // uses rather than folded into the fence's arm. §3.4's rule, held at the re-check: "somebody
      // else holds this" and "I lost my shard" must not be reachable from one another.
      if (err instanceof OrganizerStandDownError) return await standDown(err);
      if (!(err instanceof LeaderFencedError)) throw err;
      // NOT A FAILURE — a handover. The fence keys on the shard, so one refusal means every later
      // write would be refused too, and the write group that was refused wrote nothing. Reported
      // as a skip rather than thrown, because exiting 1 here would page a human for a routine
      // failover; the successor that took the shard is already syncing this mailbox.
      log.warn(cronEvent("reconcile", "leadership_lost"), {
        mailboxId, accountId: row.accountId, err,
        reason: "this process no longer leads its shard; the sweep stopped at its next write " +
          "with nothing partially applied",
      });
      return { ran: false, reason: "leadership-lost" };
    }
    // STAMP HERE TOO, and not only in the always-on worker's `cycle()`.
    //
    // This cron is the BACKSTOP: it exists for when the always-on worker is absent. So the
    // reasoning "the main loop restamps within 60s" — which is why `index.ts` was thought to
    // be the only place that needed this — is exactly false in the situation this file runs
    // in. Without the stamp a successful backstop run leaves `last_sync_at` stale, so
    // `evaluateAlerts` keeps paging `sync_lag` and the (i) panel keeps saying "not synced yet"
    // while mail is demonstrably flowing. Best-effort for the same reason as the main loop's:
    // the mail HAS synced, and a failed bookkeeping write must not turn that into an error.
    try {
      // The DB-clock variant — this stamp participates in the same `last_sync_at` the pull
      // affordance settles on, and a host-clock `new Date()` here was the one writer left that
      // could plant a future value for `stampMailboxSyncNow`'s GREATEST to preserve (2026-08-26
      // review, round 4). Backdate 0: the backstop's per-mailbox pass is a single bounded
      // reconcile, not a rotation.
      await stampMailboxSyncNow(db, [mailboxId]);
    } catch (err) {
      log.error(cronEvent("reconcile", "stamp_failed"), { mailboxId, err });
    }
    return { ran: true };
  } finally {
    if (adapter) { try { await adapter.close(); } catch { /* ignore */ } }
    // SURRENDER BEFORE RELEASING THE LOCK, and guarded on our own instance id so a successor's
    // claim cannot be clobbered by it. Best-effort: a heartbeat left behind ages out on
    // `leaderStaleMs` exactly as a crashed worker's does, and a teardown must not be abortable by
    // bookkeeping.
    if (claimedHeartbeat) {
      try { await clearHeartbeat(db as unknown as Tx, fence); }
      catch (err) { log.error(cronEvent("reconcile", "heartbeat_clear_failed"), { err }); }
    }
    try { await owned.close(); } catch (err) { log.error(cronEvent("reconcile", "pool_close_failed"), { err }); }
    await lock.release();
  }
}

if (isCliEntry(import.meta.url)) {
  // `reason` is one of seven author-written literals (`worker-live`, `other-shard`,
  // `mailbox-disabled`, `stood-down`, `lease-unreadable`, `leadership-lost`, `unknown`), never a
  // runtime-composed string — which is why it may ride on the line at all.
  void runCronCli("reconcile", runReconcileCron, (r) => ({
    ran: r.ran, fields: r.ran ? undefined : { reason: r.reason ?? "unknown" },
  }));
}
