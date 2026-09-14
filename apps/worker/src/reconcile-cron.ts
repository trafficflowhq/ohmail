import {
  makeOwnedDb, writeHeartbeat, clearHeartbeat, makeEntitlementsClient,
} from "@trafficflow/db/cloud";
import {
  closeStoodDownAppointments, UNMETERED,
  type EntitlementsComposition, type Tx,
} from "@trafficflow/db";
import { providerAuthservIds, silentLogger, type Logger } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { deriveRequestKey } from "@trafficflow/core/adapters/organizer-lease";
import { instanceIdFrom, selectionOf, type WorkerConfig } from "./config.js";
import { acquireLeaderLock, leaderLockKeyFor } from "./leader-lock.js";
import {
  accountInShard, clearOrganizerStandDown, loadMailboxById, makeSyncWriteFence,
  markMailboxStoodDown, stampMailboxSyncNow, type LeaderFence,
} from "./mailboxes.js";
import { LeaderFencedError, MailboxRemovedError, runSyncCycle, type SyncDeps } from "./sync.js";
import { isSharedDatabaseFault } from "./dead-letter.js";
import { applyMetaRequests } from "./request-drain.js";
import { OrganizerProfileSync } from "./profile.js";
import { makeStorageCapResolver } from "./storage-cap.js";
import {
  CLOUD_DISPLAY_NAME, LeaseUnavailableError, OrganizerStandDownError, acquireLeasePermit,
  cloudInstallId, leaseStoodDown, mailboxHasRequestKey, type LeasePermit,
} from "./lease.js";
import { isCliEntry } from "./entry.js";
import { cronEvent, runCronCli } from "./cron-log.js";

/**
 * WHO THE BACKSTOP IS, IN `worker_heartbeats` — deliberately NOT the always-on worker's identity. The
 * row is keyed on `shard_index` alone (the PRIMARY KEY), so "this row names me" equals "nobody has
 * taken this shard from me", which is what {@link makeSyncWriteFence} keys on and what makes claiming
 * the row make the fence REAL. The prefix keeps two processes that could share an id apart:
 * `instanceIdFrom()` reads `RAILWAY_REPLICA_ID` first, so a backstop inside the worker's own service
 * would collide, and a literal prefix makes that unrepresentable. It also answers what
 * `CRON_SERVICE = "worker-cron"` answers — is the loop running or only the backstop — since
 * `worker_down`'s detail line quotes `instance_id`.
 */
const RECONCILE_INSTANCE_PREFIX = "reconcile-cron";

/**
 * Correctness backstop. Acquires the shard's leader lock: if the always-on worker holds it this exits
 * (`ran: false`); otherwise one full sweep (two cycles → convergence) and release, never concurrent with
 * the worker. Still the single-mailbox env backstop, so it requires `TF_MAILBOX_ID` + `TF_ACCOUNT_ID` and
 * now VERIFIES the account owns the mailbox and that it is in THIS shard. The shard lock coordinates Cloud
 * workers only, so two disciplines run here too: the ORGANIZER LEASE in `ohmail/_meta`, re-asked at every
 * write boundary via a {@link LeasePermit} (2026-09-01) after `connect()` and before `ensureFolders()`;
 * and the LEADER FENCE — this claims the shard's heartbeat row, hands {@link makeSyncWriteFence} that
 * identity and wires `() => lockLost` to `lock.lost` (surrendered in `finally` via `clearHeartbeat`). It
 * does not neuter the pass (arm 4/3 for an unorganized mailbox, arm 7 for a desktop-renewed one); `log` defaults to `silentLogger` (`cron-log.ts`). */
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
    // A READER ROW IS REFUSED HERE, BEFORE THE DIAL. This whole pass is an ORGANIZER backstop (it dials,
    // takes the lease permit, ensures `ohmail/*`, runs two cycles with `role: "organizer"`) — none of
    // which a reader may do. Before 0083 the disabled-check covered it; a reader is `connected`, so that
    // predicate admits it and the pass would organize a mailbox another install holds. The permit WOULD
    // refuse it a moment later, but refusing here costs no connection, no IMAP round trip and no
    // `ensureFolders` against somebody else's mailbox, and is right even when the other organizer's
    // heartbeat has gone stale (exactly when the permit would let this through). A takeover a human
    // authorized is NOT refused: that stamp is §4's explicit action, the permit consumes it.
    if (row.organizerRole === "reader" && row.takeoverAuthorizedAt === null) {
      log.info(cronEvent("reconcile", "mailbox_reader"), {
        mailboxId, accountId: row.accountId,
        reason: "this install is a reader of this mailbox — another organizer holds it and no "
          + "takeover has been authorized — so the backstop organizes nothing here",
      });
      return { ran: false, reason: "mailbox-reader" };
    }

    /* A MAILBOX SOMEBODY HAS ASKED THIS INSTALL TO STOP ORGANIZING (0.14.1).
     * The arm above reads the ROLE, and a pending release does not move it — the row stays `organizer`
     * until the always-on gate honours the request, because the claim lives in the customer's IMAP folder
     * and expunging it belongs to the process holding that connection. So this backstop sailed past the
     * guard and did exactly what the person asked it to stop: dial, take the permit (renewing the claim
     * they asked removed), `ensureFolders`, file mail. Refusing rather than HONOURING it, because
     * releasing (expunge, write the row, close appointments) lives in exactly one place; a second copy is
     * how two doors disagree. Residual: a mailbox served ONLY by this backstop defers the release to a
     * worker cycle rather than losing it — strictly better than organizing past the request for ever.
     */
    if (row.releaseRequestedAt !== null) {
      log.info(cronEvent("reconcile", "mailbox_release_requested"), {
        mailboxId, accountId: row.accountId,
        reason: "somebody has asked this install to stop organizing this mailbox; the backstop "
          + "organizes nothing here and leaves the request for the gate that performs it",
      });
      return { ran: false, reason: "mailbox-release-requested" };
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
      // The backstop composes no classifier and therefore no circuit breaker, so it has no
      // circuit state to publish. `null` is the truth here and is also the healthy value, which
      // is the right coincidence: this process cannot resolve an `ai_provider_down` the real
      // worker opened, because it never claims the shard while that worker is alive.
      aiCircuitOpenSince: null,
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
     * THE STAND-DOWN, AS A FUNCTION — reached from FOUR places, not one. It began as the acquisition
     * `catch`'s body, correct while the lease was read once; it is not now, because `permit.check()`
     * re-runs the gate at three later write boundaries and throws {@link OrganizerStandDownError} from any,
     * and the only downstream catch accepts `LeaderFencedError` and rethrows the rest. A routine handover
     * (a user moving their mailbox to their own machine mid-sweep) would have exited this cron with a
     * thrown error instead of a recorded stand-down — no `markMailboxStoodDown`, no `"stood-down"` result,
     * an operator paged for the mechanism working. Found by the review round over the commit that added the
     * later checks: the regression was created by the fix.
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
        // The holder columns ride the same write : the demotion IS the banner, and the
        // claim this verdict was reached from is the claim the row should name.
        const written = await markMailboxStoodDown(db, mailboxId, err.reason, {
          fence,
          by: {
            kind: err.by?.kind ?? null,
            displayName: err.by?.displayName ?? null,
            claimedAt: err.by?.claimedAt ?? null,
            state: err.state,
            capabilities: err.by?.capabilities ?? null,
          },
        });
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
      // AND THE APPOINTMENTS THIS SWEEP CAN NO LONGER KEEP ARE CLOSED WITH A SENTENCE — the same call the
      // always-on worker's gate makes: a pending scheduled send does not travel (the portable profile
      // carries configuration and no drafts), and the mailbox leaves the roster. Reached from all FOUR
      // callers because it is inside `standDown` (its whole reason for existing). Best-effort, like the
      // write above: standing down is already decided and may not be made contingent on a second write,
      // and the hosted scheduled-send pass refuses a `disabled` mailbox and closes the row itself.
      // Unfenced because the fence arbitrates Cloud against Cloud while this write is justified by the
      // LEASE (a fact about `ohmail/_meta`), and a close gated on the fenced write would never run for a
      // `disabled` mailbox — the population that needs it most.
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

    /* ── THE ROW FOLLOWS THE CLAIM, WITH NOTHING AWAITED BETWEEN THEM ───────────────────────
     *
     * ONE-SHOT, as at `index.ts#mayOrganize`: the authorization bought this becoming and no other,
     * or a lapse-then-resubscribe would seize the mailbox back months later from whatever a human
     * deliberately moved it to. It rides {@link LeasePermitInput.onClaimHeld} rather than sitting
     * after the acquisition: this call site passes no `adopt`, so the claim's append, its verify
     * and the probe all happen INSIDE the permit and no reordering out here reaches the window.
     * FENCED, and the answer is READ — `false` is a write that did not land, so the press stays
     * spendable for the next sweep and the line says so.
     */
    const promote = async (): Promise<void> => {
      try {
        const promoted = await clearOrganizerStandDown(db, mailboxId, { fence });
        if (promoted) return;
        log.warn(cronEvent("reconcile", "organizer_promotion_fenced"), {
          mailboxId, accountId: row.accountId,
          reason: "the row was not promoted — this process no longer leads the shard, or the "
            + "mailbox is a tombstone; the press is unspent and the next sweep retries",
        });
      } catch (err) {
        log.warn(cronEvent("reconcile", "organizer_promotion_failed"), {
          mailboxId, accountId: row.accountId, err,
        });
      }
    };

    let permit: LeasePermit;
    try {
      permit = await acquireLeasePermit({
        adapter,
        mailboxId,
        // The SAME set the always-on worker advertises, for the same reason the install id is the
        // same one: this pass RENEWS the worker's claim rather than writing its own, so a
        // different capability set here would make `requests` appear and disappear under readers
        // depending on which process last renewed. See `hostedRequestKeyHeld`.
        hasRequestKey: mailboxHasRequestKey({ auth: { user: config.imap.user, pass: config.imap.pass }, address: row.address }),
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
        // The instant, not a flag (0.14.1) — the election ranks one press against another, so the
        // row's own stamp travels unchanged. See `mayOrganize` in `index.ts`.
        // AND THE VERB — see `index.ts`'s gate. The backstop runs the same fence, so it has to
        // hand it the same two facts about the press or it would decide a case the poll refuses.
        takeover: row.takeoverAuthorizedAt
          ? { authorizedAt: row.takeoverAuthorizedAt, intent: row.takeoverIntent }
          : null,
        // Only where there is a becoming to record: a row already saying `organizer` with no press
        // and no stand-down needs no write, which is the steady state of every ordinary sweep.
        ...(row.takeoverAuthorizedAt !== null || row.disabledReason !== null
          ? { onClaimHeld: promote } : {}),
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

    // EVERY WRITE BOUNDARY THIS PASS OWNS, RE-ASKED. It used to read the lease ONCE and write for a whole
    // sweep, defended as "not a weakening… holds the shard lock for one bounded sweep". The bound was the
    // problem: "one sweep" is `ensureFolders()` plus TWO full `runSyncCycle` calls, and a takeover inside
    // it was unobserved until exit; the shard lock is invisible to the desktop install this pass would be
    // writing beside. So the lease read carries a deadline (`LeasePermit`) asked at each boundary — here,
    // before `ensureFolders()`, and before each cycle — inside the TTL a comparison, past it one
    // `runLeaseGate` (which RENEWS). What it does NOT bound: writes INSIDE a `runSyncCycle`, gated by that
    // cycle's leader fence, so the residual is one cycle not one sweep (closing it means threading the
    // lease through `SyncDeps`). This call needs its own arm — it sits above the `runSyncCycle` try that
    // routes a stand-down to `standDown`, and would otherwise propagate.
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
      // ORGANIZER, always, and typed rather than derived . This pass reached here only
      // by passing the reader refusal above AND the lease permit, so the role is a fact about the
      // path rather than a value to look up — and typing it is what makes the census over
      // `runSyncCycle` call sites able to see this composition at all.
      role: "organizer",
      // The same host string the adapter above dials names whose report may be believed.
      trustedAuthservIds: providerAuthservIds(config.imap.host),
      // METERED, like the loop this pass stands in for: the backstop ingests the same mail the
      // worker would have, so it asks the same port for the same cap — read once here and held
      // on these deps for the sweep's two cycles.
      storageCap: await makeStorageCapResolver(
        config.entitlements
          ? makeEntitlementsClient({
            baseUrl: config.entitlements.url, secret: config.entitlements.secret,
          })
          : (UNMETERED satisfies EntitlementsComposition),
        log,
      )(accountId),
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
    /* The sweep's failure is HELD rather than propagated, for exactly as long as it takes the
     * request drain below to run — see that block, and the fence note inside it. */
    let cycleError: unknown = null;
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
      cycleError = err;
    }

    {
      // THE REQUEST DRAIN, ONCE PER SWEEP, AFTER THE CYCLES (0.14.1). This is an organizer path
      // (`role: "organizer"`, past the reader refusal and the permit), so it owes the same drain
      // `visitMailbox` owes, in the same ORDER: `ohmail/_meta` is writable by anyone with append rights,
      // so a drain that ran first would let a flood delay the sweep; the `folder_state` rows it writes are
      // picked up by the next sweep's `reconcileFolders`. ONE drain per sweep (the two cycles run back to
      // back). It runs even when a cycle THREW (else a persistent-fault mailbox drained nothing and a
      // reader's decisions expired unacknowledged), EXCEPT for three NOs that mean this pass no longer has
      // standing to write: `OrganizerStandDownError`, `LeaderFencedError`, and `LeaseUnavailableError` (an
      // unreadable lease is an unanswered question, and a WRITE must not proceed on one) — all handed on
      // to the arms below. Skipping costs only a delay; the records wait for the next drain.
      /* The stand-down is asked of the PERMIT and no longer of the throw's class: every
         stand-down on this path comes from one of the `permit.check()` calls above, and the
         permit's latch also catches the shape the class cannot — a refusal swallowed inside the
         cycle (`fileOne`, `reconcileFlags`, `folderOpsPass` each catch all but a fence), which
         arrives here with `cycleError` null and a sweep that would acknowledge and expunge
         records in a mailbox another install now organizes. The class arm below is unchanged. */
      const mayStillWrite = !leaseStoodDown(permit)
        && !(cycleError instanceof LeaderFencedError)
        && !(cycleError instanceof LeaseUnavailableError)
        // A shared-database fault is the third: this drain is database work end to end, so on a
        // Postgres outage it can only spend one IMAP round trip per mailbox to fail in a way the
        // first mailbox already established. The always-on worker's twin excludes it for the same
        // reason.
        && !isSharedDatabaseFault(cycleError)
        // And the fourth: the mailbox was REMOVED mid-cycle. The drain appends and expunges records
        // in the customer's own `ohmail/_meta`, which is the last thing to do to a mailbox somebody
        // has just disconnected — the records are nobody's to acknowledge any more.
        && !(cycleError instanceof MailboxRemovedError);
      if (mayStillWrite) {
        try {
          await applyMetaRequests(
            db, {
              mailboxId, accountId: row.accountId, adapter,
              installId: config.organizer?.installId ?? cloudInstallId(config.environment ?? "production"),
              requestKey: deriveRequestKey({ auth: { user: config.imap.user, pass: config.imap.pass }, address: row.address }),
            }, new Date(),
            (event, detail) => log.info(cronEvent("reconcile", event), { mailboxId, accountId: row.accountId, ...detail }),
          );
        } catch (err) {
          log.warn(cronEvent("reconcile", "organizer_requests_drain_failed"), {
            mailboxId, accountId: row.accountId, err,
            reason: "this sweep organizes mail regardless; the next sweep or the always-on worker drains it",
          });
        }
      }
    }

    if (cycleError !== null) {
      const err = cycleError;
      // THE ORGANIZER handover, from any of the three `permit.check()` calls above. Same shape as
      // the leader handover below and for the same reason — it is the mechanism working, not a
      // fault — but a DIFFERENT question, so it is answered by the same `standDown` the acquisition
      // uses rather than folded into the fence's arm. §3.4's rule, held at the re-check: "somebody
      // else holds this" and "I lost my shard" must not be reachable from one another.
      if (err instanceof OrganizerStandDownError) return await standDown(err);
      /* AND THE MAILBOX GOING AWAY UNDER THE SWEEP, on the fence's reasoning and not its
         mechanism: the person removed it while this pass was planning a message, the commit was
         refused with nothing written, and there is no successor to hand anything to. Reported as
         a skip because a throw here exits 1 and pages somebody for a mailbox a customer chose to
         disconnect. */
      if (err instanceof MailboxRemovedError) {
        log.info(cronEvent("reconcile", "mailbox_removed"), {
          mailboxId, accountId: row.accountId,
          reason: "this mailbox was removed while the sweep was reading it; the pending writes "
            + "were refused rather than committed into a mailbox that is gone",
        });
        return { ran: false, reason: "mailbox-removed" };
      }
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
  // `reason` is one of eight author-written literals (`worker-live`, `other-shard`,
  // `mailbox-disabled`, `mailbox-removed`, `stood-down`, `lease-unreadable`, `leadership-lost`,
  // `unknown`), never a runtime-composed string — which is why it may ride on the line at all.
  // `mailbox-disabled` and `mailbox-removed` are different readings: the first is a row that was
  // already a tombstone when the sweep looked, the second a removal that landed mid-sweep.
  void runCronCli("reconcile", runReconcileCron, (r) => ({
    ran: r.ran, fields: r.ran ? undefined : { reason: r.reason ?? "unknown" },
  }));
}
