import { type Tx, AccountErasedError } from "@trafficflow/db";
import { plantReopenedCatchUp, dropUntoldCatchUps } from "@trafficflow/db/cloud";
import { hostKeyOf } from "../attach-pool.js";
import { asDatabaseFault } from "../db-fault.js";
import {
  authRetryDeadline, loadRosterMailboxes, resumeParkedMailbox, markMailboxReleased, type EnabledMailbox, loadAttachHosts, accountsOf,
  deleteParkedPushRows, markMailboxSyncBlocked, clearMailboxSyncBlock,
} from "../mailboxes.js";
import { sample } from "../index.js";
import type { WorkerScope } from "./scope.js";

/** The worker's start function, one section: the roster pass, the blocks it writes down, and how a cycle yields to it. */
export function rosterSection(scope: WorkerScope): void {
    /**
     * Re-read the shard's duty and converge the runtime map onto it: attach newly eligible
     * mailboxes, detach ones that were disabled/deleted/evicted by the cap, recompute the
     * per-account duty and the capacity counters.
     */
    async function reconcileRoster(opts: { awaitAttaches?: boolean } = {}): Promise<void> {
      if (scope.stopped) return;

      // Say something before the first attach, and leave durable evidence. A boot-time outage was once
      // invisible for two hours, and this is the half not about locks. A leader whose first roster
      // pass blocks inside `attach` — a hung provider dial, a first `ensureFolders`, a database wait —
      // had written NO heartbeat row and emitted NO log since taking the lock, and from outside
      // "wedged mid-boot", "never started" and "no mailboxes to serve" are the same absence, which
      // nothing can page on. So the beat happens before anything that can BLOCK, and it is a beat not
      // just a log: a log is visible only to whoever is tailing, while the heartbeat row is what an
      // EXTERNAL watchdog reads. `beat()` is best-effort, so a failed write cannot stop the boot.
      if (!scope.booted) {
        scope.booted = true;
        scope.log.info("leader_boot_started", {
          maxMailboxes: scope.maxMailboxes, rosterIntervalMs: scope.rosterIntervalMs,
          pollIntervalMs: scope.config.pollIntervalMs,
          reason: "the roster pass is about to attach mailboxes; anything after this can block",
        });
      }

      const roster = await loadRosterMailboxes(scope.roster, scope.selection, new Date(), scope.parkedAccountsReader ?? undefined);
      // A new reading of the roster: each account's handle is made afresh from here on, bound to
      // the account this reading names. A cycle already under way keeps the pair it took.
      scope.forgetAccounts();
      const selected = roster.served;

      // ── THE CATCH-UP'S DATE, RECORDED BEFORE THIS PASS SPENDS IT (cloud 0040) ──────────────
      //
      // An account reading open whose rows still carry the park or the `account_closed` block has
      // just reopened, and this pass clears both (the promotion, then the pass end). The door dates
      // its catch-up note from them, so the anchor is planted untold first. A FAILED plant defers the
      // spend: that account's rows skip the resume and the block clear, and the next pass plants
      // again. Erased is final and defers nothing. Bound: a persistent write fault on the notices
      // table defers every pass, with this log line its only trace. An account whose parked
      // mailbox cannot resume yet is planted again each pass, as a DO NOTHING; with nothing
      // reopened there is no statement.
      const plantOwed = new Set<string>();
      const reopening = new Set<string>();
      for (const m of selected) {
        if (m.organizerParkedAt !== null || m.syncBlockedReason === "account_closed") reopening.add(m.accountId);
      }
      for (const accountId of reopening) {
        try {
          await plantReopenedCatchUp(scope.forAccount(accountId).db as unknown as Tx, accountId);
        } catch (err) {
          if (err instanceof AccountErasedError) continue;
          plantOwed.add(accountId);
          scope.log.error("reopened_notice_plant_failed", {
            accountId, err,
            reason: "the catch-up note's date could not be recorded, so this pass leaves the " +
              "account's closure facts standing and the next pass records them first",
          });
        }
      }

      // ── THE RESUME: a mailbox the wall released, on an account that reads open (mail 0135) ──
      //
      // The `join` a person's "Organize here" would write, and mirrored into THIS pass's row so the
      // attach and the lease refresh below carry it: organizing is back within one roster pass. The
      // gate still decides — a live foreign claim wins and the stand-down clears the marker, so a
      // lost join is never stamped again. Filtered on the row as read, so a pass with nothing
      // marked issues no statement.
      for (const m of selected) {
        if (plantOwed.has(m.accountId)) continue;
        if (m.organizerParkedAt === null || m.organizerRole !== "reader" || m.organizeConsentedAt === null
          || m.releaseRequestedAt !== null || m.takeoverAuthorizedAt !== null) continue;
        const now = new Date();
        try {
          if (await resumeParkedMailbox(scope.forAccount(m.accountId).db, m.mailboxId, { fence: scope.fence, now })) {
            m.takeoverAuthorizedAt = now;
            m.takeoverIntent = "join";
            scope.log.info("organizer_parked_resume", {
              mailboxId: m.mailboxId, accountId: m.accountId,
              reason: "the account is open again, so this install asks to organize the mailbox the " +
                "wall released; the lease decides, and a live claim elsewhere keeps it",
            });
          }
        } catch (err) {
          scope.log.error("organizer_parked_resume_write_failed", {
            mailboxId: m.mailboxId, accountId: m.accountId, err,
            reason: "the resume stamp was not written; the mailbox stays a reader and the next " +
              "roster pass tries again",
          });
        }
      }
      const served = selected.slice(0, scope.maxMailboxes);
      const dropped = selected.slice(scope.maxMailboxes);
      scope.truncated = dropped.length;
      scope.expected = served.length;
      scope.servedIds = served.map((m) => m.mailboxId);

      // …and the first beat says what the duty is, not `0/0`. The boot beat used to fire above this
      // block, before the roster was read, so the first row a watchdog saw was
      // `mailboxes: 0, expected: 0, degraded: false` — which reads as "healthy and nothing to do". For
      // a leader about to spend three minutes attaching two real mailboxes that is the most misleading
      // sentence the row can contain, and it is what an operator saw during the incident. Moved to
      // HERE, after `expected` is known, it says `0/2, degraded` instead: booting, not yet serving. The
      // blocking risk that trade reintroduces is exactly one DB read — against the same database the
      // beat writes to, so a read that hangs would have hung the beat too.
      if (scope.firstBeatPending) {
        scope.firstBeatPending = false;
        await scope.beat();
      }

      // ── THE CAP, ON THE ROW AND NOT ONLY IN THE LOG (mail migration 0029) ───────────────
      //
      // The quietest of the three arms. A capped mailbox is not counted in `expected`, so
      // `degraded` stays FALSE and `/health` reports a perfectly healthy worker; the log line
      // fires once per change of the dropped SET, so a stable overflow says nothing after the
      // first pass. Nothing anywhere told the mailbox's owner, or an operator looking at that one
      // mailbox, that this deployment had decided not to serve it.
      const droppedIds = new Set(dropped.map((m) => m.mailboxId));
      for (const id of [...scope.capDropped.keys()]) if (!droppedIds.has(id)) scope.capDropped.delete(id);
      for (const m of dropped) scope.noteBlock(scope.capDropped, m.mailboxId, "at_capacity");

      if (dropped.length > 0) {
        const signature = dropped.map((m) => m.mailboxId).sort().join(",");
        if (signature !== scope.announced.cap) {
          scope.announced.cap = signature;
          const accounts = new Set(dropped.map((m) => m.accountId));
          scope.log.error("mailbox_cap_exceeded", {
            serving: served.length, selected: selected.length, maxMailboxes: scope.maxMailboxes,
            dropped: dropped.length, accountsAffected: accounts.size,
            sample: sample(dropped),
            reason: "these mailboxes will NOT be synced by this process — raise TF_MAX_MAILBOXES or add shards",
          });
        }
      } else {
        scope.announced.cap = "";
      }

      // ── THE WALL: a parked account's mailboxes (mail 0124) ─────────────────────────────
      //
      // Their roster removal is `loadRosterMailboxes`' filter above; this is the bookkeeping the
      // removal alone cannot do. The claim release itself stays the detach loop below — leaving
      // the duty is the ONE teardown path that releases — and the ROW is stood down here, once
      // per closure by its own state (`organizer_role = 'organizer'` guards the write), so a
      // restart mid-park still records the release. Consent is KEPT, and the row carries the
      // wall's marker: once the account reads open, the resume above asks for it back as a `join`.
      const parkedIds = new Set(roster.parked.map((m) => m.mailboxId));
      for (const id of [...scope.parkedBlocked.keys()]) if (!parkedIds.has(id)) scope.parkedBlocked.delete(id);
      for (const m of roster.parked) {
        scope.noteBlock(scope.parkedBlocked, m.mailboxId, "account_closed");
        if (m.organizerRole !== "organizer") continue;
        try {
          const written = await markMailboxReleased(scope.forAccount(m.accountId).db, m.mailboxId, { fence: scope.fence, cause: "account_parked" });
          if (written) {
            scope.log.warn("organizer_parked_account_released", {
              mailboxId: m.mailboxId, accountId: m.accountId,
              reason: "the account's subscription ended, so this install stood the organizer " +
                "down; the row keeps its credentials, its consent and its mirror, and organizing " +
                "resumes on its own once the account is open again",
            });
          }
        } catch (err) {
          scope.log.error("organizer_parked_release_write_failed", {
            mailboxId: m.mailboxId, accountId: m.accountId, err,
            reason: "the roster still detaches the runtime and the claim lapses on its own; " +
              "the row's stand-down is retried next pass",
          });
        }
      }
      // A closure read for the first time ends any catch-up an earlier reopening left untold: nobody
      // was shown it before the account closed again. Here, at the first pass that reads the account
      // parked, and never behind the block grace, which a closure paid within minutes never reaches.
      const parkedAccountIds = new Set(roster.parked.map((m) => m.accountId));
      for (const id of [...scope.closureDropped]) if (!parkedAccountIds.has(id)) scope.closureDropped.delete(id);
      for (const accountId of parkedAccountIds) {
        if (scope.stopped) return;
        if (scope.closureDropped.has(accountId)) continue;
        try {
          await dropUntoldCatchUps(scope.forAccount(accountId).db as unknown as Tx, accountId);
          scope.closureDropped.add(accountId);
        } catch (err) {
          if (err instanceof AccountErasedError) { scope.closureDropped.add(accountId); continue; }
          scope.log.error("reopened_notice_drop_failed", {
            accountId, err,
            reason: "an earlier reopening's untold catch-up note could not be dropped; the next " +
              "pass tries again, and until then a reopening may name that earlier closure's date",
          });
        }
      }
      const desired = new Map(served.map((m) => [m.mailboxId, m]));

      // Detach anything no longer in the duty: soft-disabled, deleted,
      // or pushed out of the cap. Leaving it attached keeps an IDLE connection open — and keeps
      // syncing a mailbox whose credentials may already have been deleted.
      for (const rt of [...scope.runtimes.values()]) {
        if (scope.stopped) return;
        // A RUNTIME IS NEVER MOVED TO ANOTHER ACCOUNT. Its handle, its repository and its sync deps
        // were bound at its attach, to the account of the row it was attached from. A reading of
        // the roster that names another account for the same mailbox ends it here, and the
        // scheduling below attaches the mailbox afresh under the account this reading names. No
        // claim is released: the mailbox is still this shard's.
        const named = desired.get(rt.mailboxId);
        if (named !== undefined && named.accountId !== rt.accountId) {
          const reason = "the roster names another account for this mailbox";
          scope.log.error("mailbox_account_changed", {
            mailboxId: rt.mailboxId, accountId: rt.accountId, namedAccountId: named.accountId,
            reason: "the mailbox's row names another account than the one this connection was " +
              "attached under; the connection is closed and the mailbox attached again under the " +
              "account its row names, and nothing is written for it under the old one",
          });
          // Not while a lane is inside it, for the reason below: the cycle ends it once its lanes joined.
          if (scope.laneBusy.has(rt.mailboxId)) scope.deferredLeaves.push({ rt, release: false, reason });
          else await scope.detach(rt, reason);
          continue;
        }
        if (!desired.has(rt.mailboxId)) {
          // Not while a lane is inside it. This is the ONE detach reachable from inside a running
          // cycle — a roster pass served by `yieldToRoster` — and with lanes it can now land on a
          // mailbox whose `changesSince` is suspended. Closing that adapter would abort a batch
          // mid-flight and, through `releaseOrganizerClaim` below, hand the mailbox away while this
          // process is still organizing it. DEFERRED, never skipped: the cycle drains `deferredLeaves`
          // once its lanes have joined, so the mailbox leaves in the same cycle it stopped being ours.
          // The duty-gap check is unaffected — a mailbox still in `runtimes` is `served` by it, which
          // is what it is until the drain runs.
          if (scope.laneBusy.has(rt.mailboxId)) {
            scope.deferredLeaves.push({
              rt, release: true, reason: "no longer an enabled mailbox of this shard",
            });
            continue;
          }
          // The entitlement lapse releases the claim, not just the roster row. BEFORE the detach,
          // because the detach closes the connection that can do it. This is the ONLY teardown path
          // that releases, and the discrimination is the point: `detach` is also reached by a
          // connection error, a quarantine, a lost lock and a clean stop, and in every one Cloud fully
          // intends to keep organizing — a release there would hand the mailbox to a desktop install on
          // every deploy. Leaving the duty is the opposite: the account lapsed, the user disconnected,
          // or the cap evicted it, and a live claim Cloud no longer renews is what makes the user's own
          // machine stand ITSELF down for the staleness window — ten minutes of a "leave anytime"
          // product whose button appears to do nothing at the moment somebody chose to leave.
          await scope.releaseOrganizerClaim(rt, "this mailbox is no longer an enabled mailbox of this shard");
          await scope.detach(rt, "no longer an enabled mailbox of this shard");
        }
      }
      for (const id of [...scope.awaitingCreds.keys()]) if (!desired.has(id)) scope.awaitingCreds.delete(id);
      for (const id of [...scope.quarantine.keys()]) if (!desired.has(id)) scope.quarantine.delete(id);
      for (const id of [...scope.leaseBlocked.keys()]) if (!desired.has(id)) scope.leaseBlocked.delete(id);
      // An attach still waiting for its slot is dropped with its duty; one already running finishes,
      // and if it adds a mailbox that has left, the next pass detaches it and releases the claim.
      const now = Date.now();
      scope.attachPool.dropQueued((id) => {
        const mb = desired.get(id);
        return mb === undefined || now >= authRetryDeadline(mb);
      });

      // Schedule what is missing. The pass does not wait for the attaches (except at boot): each one
      // kicks and nudges a cycle as it joins the rotation (`attach-nonblocking.e2e.test.ts`, claim 7),
      // because `attach()` syncs nothing and the poll timer's first tick is a full period away.
      const toSchedule: EnabledMailbox[] = [];
      for (const mb of served) {
        if (scope.stopped) return;
        const attached = scope.runtimes.get(mb.mailboxId);
        // One still attached under another account waits for its cycle to end it (above): nothing
        // of this row is written into it.
        if (attached && attached.accountId !== mb.accountId) continue;
        if (attached) {
          // Refresh the lease-relevant columns from the row we just read, so a takeover
          // authorized by the connect flow while this mailbox was already serving reaches the
          // next cycle's gate instead of waiting for a restart.
          attached.lease = {
            // Mail 0104 — the verb moves with the stamp on every refresh, for the same reason.
            takeoverAuthorizedAt: mb.takeoverAuthorizedAt, takeoverIntent: mb.takeoverIntent,
            disabledReason: mb.disabledReason,
            // Mail 0083, refreshed with the other two: a promotion or demotion written by
            // another process (the connect flow, the reconcile backstop) is a fact about this
            // row, and a value captured at attach would leave this gate deciding against it.
            organizerRole: mb.organizerRole,
            // Mail 0083. Refreshed for `takeover_authorized_at`'s exact reason: `organizeHere`
            // stamps CONSENT from another process while this one is already reading the mailbox,
            // and a value captured at attach would leave a person's "organize here" doing
            // nothing until the worker happened to restart. The two columns are written in one
            // transaction, so refreshing them together is also what keeps them consistent here.
            organizeConsentedAt: mb.organizeConsentedAt,
            // Mail 0088. Refreshed with the pair above and for the identical reason: "stop
            // organizing this mailbox" is written by ANOTHER process while this one is already
            // organizing it, and a value captured at attach would leave the person's press
            // doing nothing until the worker happened to restart.
            releaseRequestedAt: mb.releaseRequestedAt,
            organizerReleasedAt: mb.organizerReleasedAt,
          };
          // Converge the row onto reality — but only about a mailbox that has actually SYNCED. This
          // mailbox is attached; if its row still says `error` the recovery write failed or was
          // fenced, and until this line NOTHING retried it (the old comment claimed "the next roster
          // pass writes it" and this loop's `continue` was the proof it did not — the mailbox synced
          // perfectly while Settings and the admin console called it broken). `mb.status` is re-read
          // every pass, so this is a no-op the moment the write lands. `lastSuccessAt !== null` is the
          // non-blocking-attach half: "attached" no longer implies "drained twice", so without this
          // clause a mailbox whose login works and whose every cycle throws would be converged to
          // `connected` 30 s later — resurrecting the "connected flashes on a never-synced mailbox".
          if (mb.status !== "connected" && attached.lastSuccessAt !== null) await scope.markRecovered(mb);
          continue;
        }
        const authDeadline = authRetryDeadline(mb);
        if (now >= authDeadline) {
          if (!scope.quarantine.has(mb.mailboxId)) {
            scope.quarantine.set(mb.mailboxId, {
              attempts: mb.retryCount, retryAt: authDeadline, reason: "waiting for a new sign-in", persisted: true,
            });
          }
          continue;
        }
        // Already in the pool: a queued attach takes this pass's row, a running one keeps its own.
        const inPool = scope.attachPool.state(mb.mailboxId);
        if (inPool === "queued") { scope.attachPool.replaceQueued(mb.mailboxId, (t) => scope.attach(mb, t)); continue; }
        if (inPool === "running") continue;
        // A persisted wait follows the row, so an operator can clear its timer for one
        // extra attempt. A person's retry reset clears the timer and starts a fresh ladder.
        // If persistence failed, keep the in-process wait. A new leader seeds from the row.
        const q = scope.quarantine.get(mb.mailboxId);
        if (q) {
          const until = q.persisted ? (mb.retryAfter?.getTime() ?? null) : q.retryAt;
          if (until !== null && now < until) continue;
          if (q.persisted && mb.kickStamp !== null && mb.status === "connected" && mb.retryAfter === null) {
            scope.quarantine.delete(mb.mailboxId);
          }
        } else if (mb.retryAfter !== null) {
          const retryAt = mb.retryAfter.getTime();
          const attempts = Math.max(1, mb.retryCount);
          scope.quarantine.set(mb.mailboxId, {
            attempts, retryAt, reason: "recovered from mailboxes.retry_after on takeover", persisted: true,
          });
          if (now < retryAt) {
            scope.log.info("mailbox_quarantine_restored", {
              mailboxId: mb.mailboxId, accountId: mb.accountId, retryInMs: retryAt - now, attempts,
              reason: "a durable backoff outlived the process that set it",
            });
            continue;
          }
        }
        toSchedule.push(mb);
      }
      const scheduled: string[] = [];
      if (toSchedule.length > 0) {
        // Read each scheduled account’s hosts on its own handle.
        const hosts = await asDatabaseFault("roster.attachHosts",
          () => loadAttachHosts(toSchedule, scope.forAccount));
        if (scope.stopped) return;
        for (const mb of toSchedule) {
          const queued = scope.attachPool.enqueue({
            mailboxId: mb.mailboxId, accountId: mb.accountId,
            hostKey: hostKeyOf(hosts.get(mb.mailboxId), mb.mailboxId),
            run: (t) => scope.attach(mb, t),
          });
          if (queued) scheduled.push(mb.mailboxId);
        }
        const c = scope.attachPool.counts();
        scope.log.info("roster_attach_scheduled", { queued: c.queued, inFlight: c.running });
      }
      // THE BOOT CONTRACT: startup resolves only once every boot attach has settled, no cycle runs
      // before it (this pass holds the queue), and a shared fault in one rejects the start.
      if (opts.awaitAttaches && scheduled.length > 0) {
        const { fault } = await scope.attachPool.settled(scheduled);
        if (fault !== null) throw fault;
        if (scope.stopped) return;
      }

      scope.dutyAccounts = accountsOf(served);
      scope.dutyMailboxes = served;

      // The roster invariant, checking what is actually SERVED rather than what was selected.
      // Every mailbox of the shard's duty must be in exactly one accounted-for bucket:
      // attached, being attached, awaiting credentials, or quarantined with a retry scheduled.
      // Anything else is a paying customer whose mail silently never syncs, i.e. a bug in this file.
      // No await since the enqueue above, so a scheduled attach is still in the pool here.
      const unexplained = served.filter(
        (m) => !scope.runtimes.has(m.mailboxId) && !scope.awaitingCreds.has(m.mailboxId)
          && !scope.quarantine.has(m.mailboxId) && !scope.leaseBlocked.has(m.mailboxId)
          && scope.attachPool.state(m.mailboxId) === null,
      );
      scope.dutyGap = unexplained.length > 0;
      if (scope.dutyGap) {
        const accounts = new Set(unexplained.map((m) => m.accountId));
        scope.log.error("roster_invariant_violated", {
          unexplained: unexplained.length, accountsAffected: accounts.size,
          sample: sample(unexplained),
          reason: "enabled mailboxes of this shard are neither served, awaiting credentials, " +
            "quarantined, nor held by another organizer — their mail will NEVER sync",
        });
      }

      // LAST in the pass, and the only place `sync_blocked_reason` is written. See below.
      // The parked rows ride along (mail 0124): they are filtered out of `selected` by
      // construction, and the writer below is what puts `account_closed` on them — and what
      // clears it, because an un-parked account's rows re-enter `selected` with no bucket; the
      // catch-up's date was planted at the top of this pass, and a failed plant defers the clear.
      await reconcileSyncBlocks([...selected, ...roster.parked], plantOwed);

      // Push rows go with the block, after it is written: idempotent, and only for an account
      // every live mailbox of which says `account_closed` as the delete runs (mail 0135).
      const parkedAccounts = [...new Set(roster.parked.map((m) => m.accountId))];
      try {
        // ONE statement over every parked account of the shard: it names none, and runs on the roster's view.
        await deleteParkedPushRows(scope.roster, parkedAccounts);
      } catch (err) {
        scope.log.error("parked_push_delete_failed", {
          accounts: parkedAccounts.length, err,
          reason: "push subscriptions of parked accounts could not be deleted this pass; " +
            "the delete repeats next pass",
        });
      }
    }

    /**
     * The single writer of `sync_blocked_reason` (mail 0029). One place reads the three buckets,
     * compares elapsed time against ONE threshold, and writes or clears. The catch arms above only
     * RECORD, and that split is the design: an arm that decided for itself would need its own grace,
     * its own fenced write and its own idea of when to clear — three copies in the three places least
     * likely to be exercised. LAST in the roster pass, so a mailbox that recovered this pass is cleared
     * the same pass (`selected`, not `served`, because the capacity arm's mailboxes are what `served`
     * excludes). The write REPEATS (idempotent — `markMailboxSyncBlocked` COALESCEs
     * `sync_blocked_since`) and CONVERGES a row another writer cleared; the clear is gated on the row ACTUALLY carrying a reason, or a healthy shard issues one pointless UPDATE per mailbox per interval. Best-effort — a worker ahead of mail 0029 fails these on a missing column, harmlessly.
     */
    async function reconcileSyncBlocks(
      selected: readonly EnabledMailbox[], deferred: ReadonlySet<string>,
    ): Promise<void> {
      const nowMs = Date.now();
      for (const mb of selected) {
        if (scope.stopped) return;
        // A reopened account whose catch-up was not recorded keeps its block one more pass.
        if (deferred.has(mb.accountId)) continue;
        // The park first (it holds only this pass's parked rows): a ceiling or a throttle noted before
        // it must not keep account_closed off the row, the closure a worker started in a plane fault reads.
        const block = scope.parkedBlocked.get(mb.mailboxId)
          ?? scope.leaseBlocked.get(mb.mailboxId)
          ?? scope.awaitingCreds.get(mb.mailboxId)
          ?? scope.capDropped.get(mb.mailboxId)
          ?? scope.readLimited.get(mb.mailboxId);
        try {
          // `>=`, so a grace of 0 writes on the first observation — which is what the roster guards
          // configure. The narrowing is written inline rather than hoisted into a `due` boolean
          // because a boolean would not carry `reason !== null` into the branch, and the cast that
          // replaced it is the kind of assertion a reviewer has to take on trust.
          if (block && block.reason !== null && nowMs - block.since >= scope.syncBlockGraceMs) {
            const reason = block.reason;
            // The wall's block rests on a verdict the reopening door can overturn mid-pass: it
            // lands only on a row not kicked since this roster read it (mail 0135).
            const written = await markMailboxSyncBlocked(scope.forAccount(mb.accountId).db, mb.mailboxId, reason, {
              fence: scope.fence, ...(reason === "account_closed" ? { kickAsRead: mb.kickStamp } : {}),
            });
            if (!written) {
              scope.log.info("mailbox_sync_block_write_fenced", {
                mailboxId: mb.mailboxId, accountId: mb.accountId, syncBlockedReason: reason,
                reason: "the mailbox is disabled or this instance no longer leads the shard",
              });
              continue;
            }
            // Once per transition into the blocked state, not once per pass: the write above is
            // idempotent and repeats, and a line every 30 s per unserved mailbox is how the log
            // that is supposed to explain an incident becomes the reason nobody reads it.
            if (mb.syncBlockedReason !== reason) {
              scope.log.warn("mailbox_sync_blocked", {
                mailboxId: mb.mailboxId, accountId: mb.accountId, syncBlockedReason: reason,
                reason: "this process is NOT syncing this mailbox and the row now says so — " +
                  "status is unchanged, no error is recorded, and no retry backoff is earned",
              });
            }
          } else if (!block?.reason && mb.syncBlockedReason !== null) {
            if (await clearMailboxSyncBlock(scope.forAccount(mb.accountId).db, mb.mailboxId, { fence: scope.fence })) {
              scope.log.info("mailbox_sync_block_cleared", {
                mailboxId: mb.mailboxId, accountId: mb.accountId,
                reason: "this mailbox is being served again, or is no longer ours to serve",
              });
            }
          }
        } catch (err) {
          scope.log.error("mailbox_sync_block_write_failed", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            reason: "this process is not serving the mailbox regardless; the row could not record " +
              "why, so it reads as an ordinary connected mailbox",
          });
        }
      }
    }

    /**
     * A roster pass is owed from NOW. Called by the roster timer, and by nothing else.
     *
     * Sets the flag AND queues an entry. The flag lets a cycle already in flight serve the pass
     * at its next safe point; the entry is what runs it when no cycle is in flight at all.
     * Deduped like `kickCycle`, so fourteen ticks during one long cycle no longer append
     * fourteen identical passes to the queue — they append one, and `rosterPendingSince` keeps
     * the age of the OLDEST of them, which is the number worth reporting.
     */
    function requestRoster(): void {
      if (scope.stopped) return;
      if (!scope.rosterPending) {
        scope.rosterPending = true;
        scope.rosterPendingSince = Date.now();
      }
      // And make it audible to a cycle that is already blocked on its lanes. `yieldToRoster` is at the
      // top of the dispatcher loop, and that loop only turns when a lane finishes — so a pass owed
      // while every lane is inside a long batch waited out a bounded batch (~254 s measured) before it
      // was even LOOKED at (the adoption fix's residual, unchanged by lanes alone). The nudge spends
      // it: the pass is served at the next turn of the loop, with the lanes still running. Safe for the
      // reason `laneBusy` exists — the pass's detach loop skips any mailbox a lane is inside, and
      // everything else it does (attaching a lane-less mailbox, recomputing the duty, converging rows)
      // never touches a live batch.
      scope.nudgeCycle();
      if (scope.rosterQueued) return;
      scope.rosterQueued = true;
      void scope.serialize(async () => {
        scope.rosterQueued = false;
        await servePendingRoster();
      }).catch((err: unknown) => {
        // A roster pass is a DB read: a failure is a DB blip, not a reason to stop serving
        // the mailboxes already attached. Log and try again next interval.
        scope.log.error("roster_pass_failed", { err, reason: "keeping the current rotation" });
      });
    }

    /**
     * Run the owed pass, if it is still owed. The flag is cleared BEFORE the await, not after: a timer
     * tick landing while the pass is running is a request for the NEXT pass — it has not been served by
     * a read that already happened — and clearing afterwards would swallow it. Reached from two places,
     * never concurrently: the queued entry above, and `yieldToRoster` from inside a running cycle. Both
     * are on the one queue, so "the queued entry starts while a cycle holds the queue" is not a state
     * this program has.
     */
    async function servePendingRoster(): Promise<void> {
      if (scope.stopped || !scope.rosterPending) return;
      scope.rosterPending = false;
      const waitedMs = Date.now() - scope.rosterPendingSince;
      // The half of the starvation finding that was "and nothing surfaces it". A pass that is owed and
      // cannot run emitted NOTHING while it was happening: no log, no counter, no column.
      // `mailboxes`/`expected` in the heartbeat cannot show it — they are written BY the pass that is
      // not running — so from outside a starved shard and a healthy one are the same row. This line is
      // the difference, a `warn` because a pass later than its own interval means one queue entry ran
      // longer than the interval, worth knowing even when it is a legitimately slow backfill.
      // `latencyMs` and not `waitedMs`: the logger's ALLOWED_FIELDS is the primary redaction control
      // and a key not on it has its VALUE dropped silently (the first version emitted `waitedMs` and
      // its own test read `NaN`).
      if (waitedMs >= scope.rosterIntervalMs) {
        scope.log.warn("roster_pass_delayed", {
          latencyMs: waitedMs, rosterIntervalMs: scope.rosterIntervalMs, mailboxes: scope.runtimes.size,
          reason: "a cycle held the one serial queue past a roster interval — mailboxes " +
            "connected in this window were not adopted until now",
        });
      }
      await reconcileRoster();
    }

    /**
     * Hand the queue to an owed roster pass, from inside the cycle that is holding it. Called from
     * EXACTLY ONE place: the top of the rotation's dispatcher loop, the only point where no mailbox is
     * being TAKEN and the runtime map is not being walked. The comment used to say "…between two
     * mailboxes, where NO ADAPTER OPERATION IS SUSPENDED", which bought one thing — a pass may never
     * close an adapter somebody is using — and lanes make that no longer literally true, so it is
     * enforced by name: `laneBusy` holds the ids a lane is inside, and `reconcileRoster` defers their
     * detach to `deferredLeaves`. The bound IS the roster interval now (`requestRoster` nudges a cycle
     * blocked on its lanes); two organizers come from two things organizing ONE mailbox, and a mailbox being attached has no lane. `reconcileRoster` runs through `servePendingRoster` DIRECTLY, never `serialize` — this is already inside the queue's running entry.
     */
    async function yieldToRoster(): Promise<void> {
      if (scope.stopped || !scope.rosterPending) return;
      // A roster pass that throws must not take the rotation with it. `requestRoster`'s queued entry
      // always caught this (a roster pass is a DB read, a failure a blip, not a reason to stop serving
      // attached mailboxes), and the in-cycle path had no catch — the same failure tolerated on one
      // path and fatal on the other. It is not cosmetic: uncaught, a dead database's throw out of the
      // roster read left `cycle()` before a lane ran, so `noteDatabaseFault` never fired and
      // `/health` answered `degraded: false` through a total outage. Caught here, the pass is
      // skipped, the lanes meet the database through the tagged repo, and the outage is announced
      // (`shared-db-fault.pg.test.ts`).
      try {
        await servePendingRoster();
      } catch (err) {
        scope.log.error("roster_pass_failed", {
          err,
          reason: "the pass a running cycle was serving could not read the roster; keeping the " +
            "current rotation so the mailboxes already attached are still served this pass",
        });
      }
    }
    scope.reconcileRoster = reconcileRoster;
    scope.requestRoster = requestRoster;
    scope.yieldToRoster = yieldToRoster;
}
