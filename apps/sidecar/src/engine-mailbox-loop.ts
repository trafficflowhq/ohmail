import { isImapBoundExceeded, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { type Tx, seqBounds } from "@trafficflow/db";
// ── THE ONE PIPELINE ────────────────────────────────────────────────────────────────────────
// `runSyncCycle` is imported, never reimplemented. There is ONE pipeline implementation and both
// the desktop engine and the hosted service run it: two engines diverge, and divergence here means
// mail filed differently on desktop than in the cloud. A local copy of this loop would be a second
// implementation of ingest ordering, cursor advancement and reconcile — exactly the defect the
// single-implementation rule exists to prevent — so the sidecar takes the dependency instead.
//
// It lives in the worker package today because the worker was its only caller. If the loop later
// moves into a package shared by both hosts, this import moves with it and nothing else here
// changes. A test in this package fails if a second copy of the loop ever appears beside it.
import { runSyncCycle } from "@ohmail/organizer/sync";
import { isDeviceStoreFault } from "@ohmail/organizer/dead-letter";
import { LeaseUnavailableError, leaseStoodDown, writeDoorOf, cycleWriteAuthority } from "@ohmail/organizer/lease";
// THE SYMMETRIC-TAKEOVER REQUEST DRAIN (0.14.1), from the worker's own subpath for
// the same reason `OrganizerProfileSync` is: one implementation of "apply a reader's decision" or
// "carry this install's own decisions to the mailbox", not a second one that could disagree with
// what the hosted worker does.
import {
  applyMetaRequests, driveOutstandingRequests, settleOwnOutstandingRequests,
} from "@ohmail/organizer/request-drain";
import type { LocalRosterRow } from "./identity.js";
import { mirroredFirstSyncFacts } from "./local-mirror.js";
import { nextIdlePollMs, ConnectionReplacedError } from "./engine-reconnect.js";
import { fetchRefused, drainFailureKeepsTheLogin } from "./engine-classifiers.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";

/** The desktop's engine, one section: one mailbox's loop: the pass, the schedule, the signals and the wake. */
export function loopSection(scope: EngineScope, box: MailboxScope, mb: LocalRosterRow): void {
      /* PUT THE IDLE BACK ON INBOX — the LAST act of a pass, as in the worker, on both of its exits
         (completed, and failed after the request channel ran). The cycles, the request channel and
         the publish all re-SELECT (the last two `ohmail/_meta`), and imapflow idles on whatever is
         selected: re-armed inside `drain()`, the IDLE rested on `_meta` and arrivals waited for the
         ladder (56-120 s on 0.26.1). Never over a replaced or failed connection, never after a
         hand-back (nothing listens there; `resume()` drains and re-arms). Logged, never thrown. */
      const restOnInbox = async (gen: number, conn: MailboxAdapter, failure: unknown): Promise<void> => {
        if (!box.restMayBeTaken || box.stopped || box.handedBack || typeof conn.rearmWatch !== "function") return;
        if (failure !== null && !drainFailureKeepsTheLogin(failure)) return;
        try {
          box.assertSameConnection(gen, conn);
        } catch {
          return;                       // replaced: the new connection's dial arms its own watch
        }
        try {
          await conn.rearmWatch();
        } catch (err) {
          scope.log("local_wake_rearm_failed", {
            err,
            reason: "the INBOX watch could not be re-armed after this drain, so arrivals may " +
              "wait for the poll until the connection is re-dialled",
          });
        }
      };
      const drainPass = async (maxCycles = 100): Promise<number> =>
        box.serialize(async () => {
          // The gate, immediately before `runSyncCycle`, once per DRAIN not per inner cycle:
          // re-reading the lease between batches of one drain would be an append and an expunge
          // per batch for a claim nothing could have changed; the poll timer re-enters here, so
          // the re-verification interval is the poll interval. On the PUBLIC entry point, not only
          // `start()`, because `Sidecar` exposes this method and a skippable gate is no gate.
          // `stopped` FIRST: a stand-down closed the login, so reading the lease over a dead
          // connection would throw `LeaseUnavailableError` out of a method whose honest answer is
          // "this install organizes nothing" (`stop()` reaches the same state).
          box.ringQueued = false;
          if (box.stopped) return 0;
          /* ── WHICH CONNECTION THIS PASS IS ABOUT, CAPTURED BEFORE THE GATE READS IT ─────────
           *
           * The lease is read once per drain, on one connection, and everything after it is done
           * on the strength of that read. Both facts are therefore captured here, together, and
           * carried through the whole pass: the GENERATION so each mailbox write can re-check
           * that it is still current, and the INSTANCE so the cycles write to the connection the
           * gate actually asked, rather than to whatever the binding holds by then. */
          const gen = box.generation;
          const conn = box.adapter;
          /* The gate answers a ROLE, not admission. It was `if (!(await mayOrganize())) return 0`,
           * which made a stood-down install do NOTHING and contradicted the reader half of this
           * file: a demoted install keeps draining — its mirror grows, it marks read (`\Seen`, the
           * reader's one IMAP write) and sends. `drain` is the only path to `runSyncCycle`, so the
           * reader's cycle was unreachable and `reconcileFlags` never ran (`read-writeback-live.ts`
           * measured an empty mirror). Now `mayOrganize()` runs for its decision AND side effects;
           * only the removed-mailbox arm, which sets `stopped`, stops the drain. The stand-down arm
           * sets neither, which is the distinction. */
          let organizing: boolean;
          try {
            organizing = await box.mayOrganize();
          } catch (err) {
            /* A `_meta` too full to read is swept here, on the connection the gate asked, before
               the refusal travels on; every other refusal runs nothing (`shrinkMetaOnRefusal`). */
            await box.shrinkRefusedMeta(err, conn);
            throw err;
          }
          if (box.stopped) return 0;
          /* THE GAP FOLLOWS THE ROLE THIS PASS RUNS UNDER: organizing re-arms the next gap's note, and
             a pass that does not organize withdraws the catch-up's licence until a new tenure has a
             quiet drain of its own (`noteIdleOutcome`). */
          /* A stand-down ends this organizing life, as on the hosted worker (`forgetOrganizerLife`), and so
             does an organizing pass that did not continue this process's claim: another install may have
             organized in between (a hand-back and resume, a sleep through a takeover). */
          if (box.lastPassOrganizing && !(organizing && box.gateContinued)) box.profileSync.forgetOrganizerLife();
          box.lastPassOrganizing = organizing;
          if (organizing) box.gapOpen = null;
          else scope.gapCatchupReady.delete(mb.id);
          /* Create the `ohmail/*` tree at the moment this install becomes the organizer. `start()`
           * calls `ensureFolders` behind its own `permitted` gate, which was the ONLY call; a
           * MID-LIFE promotion — now the ordinary path, since a fresh install comes up a reader and
           * "Agree and start organizing" promotes on the next pass — reached none of it and routed
           * into folders the server did not have. ONCE PER PROCESS: the flag is armed by whichever
           * path arrives first. A failure is NOT fatal and the flag is NOT set on it, so the drain
           * still mirrors and the next pass retries. */
          if (organizing && !box.foldersEnsured) {
            try {
              /* THE MAILBOX WRITE THIS WHOLE ORDERING PROTECTS — creating somebody else's
                 `ohmail/*` tree. Refused outright if the connection has moved since the gate. */
              box.assertSameConnection(gen, conn);
              await conn.ensureFolders(writeDoorOf({ lease: box.leasePermit }));
              box.foldersEnsured = true;
            } catch (err) {
              scope.log("ensure_folders_failed", {
                err,
                reason: "this install has just become the organizer and its ohmail/* tree could not "
                  + "be created; nothing is routed into a folder that does not exist and the next "
                  + "pass asks again",
              });
            }
          }
          /**
           * The request drain / the reader's own cycle (0.14.1). ONCE per `syncUntilQuiet()`, not
           * per inner `drain()` cycle — it reads or writes `ohmail/_meta`, a round trip per poll.
           * Organizing → `applyMetaRequests` (apply a reader's decision, expunge it); otherwise →
           * `driveOutstandingRequests` (append this install's decisions, observe what the organizer
           * took). Neither performs a physical IMAP move — `drain()`'s `runSyncCycle`, right after,
           * reconciles the `folder_state` rows either writes (see `@trafficflow/worker`'s header).
           */
          //
          // Why the drain's log is translated here and NOT forwarded: `(event, detail) =>
          // log(event, { ...detail })` is the obvious wiring and this door may not use it.
          // `log-census.test.ts` requires every call site here to carry a LITERAL event name and a
          // readable field set, because this is the published desktop payload — a forwarded name is
          // unenumerable, a spread detail unauditable. So the drain's outcomes become three literal
          // lines with explicit fields, and anything else is counted under a fourth.
          const noteRequestEvent = (event: string, detail: Record<string, unknown>): void => {
            const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
            if (event === "organizer_requests_drained") {
              scope.log("organizer_requests_drained", {
                mailboxId: mb.id,
                applied: num(detail.applied),
                refused: num(detail.refused),
                deferred: num(detail.deferred),
                // Records this build deliberately left alone — a future protocol, or a kind it has
                // no applier for. Nonzero here is normal; nonzero `refused` is not.
                standing: num(detail.standing),
              });
              return;
            }
            if (event === "outstanding_requests_driven") {
              scope.log("outstanding_requests_driven", {
                mailboxId: mb.id,
                sent: num(detail.sent),
                applied: num(detail.applied),
                // The organizer said no, and said why. Absent before the acknowledgement model:
                // a reader could not tell a refusal from an application at all.
                refused: num(detail.refused),
                expired: num(detail.expired),
              });
              return;
            }
            // The refusals and the transient IO failures. The NAME rides as a value under
            // `outcome`, never as the event, so the roster this package publishes stays the set
            // written above and the field is one the logger already keeps.
            scope.log("organizer_requests_note", { mailboxId: mb.id, outcome: event });
          };
          /* The mail pass's failure is HELD rather than propagated, for exactly as long as it
           * takes the request channel below to run. See that block. */
          let cycleError: unknown = null;
          let cycles = 0;
          box.drainDeclined = false;
          try {
            cycles = await box.settledDrain(maxCycles, gen, conn, organizing);
          } catch (err) {
            // Held: the request drain below runs once, then this is rethrown.
            cycleError = err;
          }

          // The request channel, after the mail. Ordered so a flood of `ohmail/_meta` records
          // cannot delay reading someone's mail (bounded on both axes in `request-drain.ts`). It
          // runs even when the mail pass FAILED: a persistent sync fault used to drain nothing, so
          // a decision made elsewhere expired reporting NOBODY TOOK IT while an organizer was live.
          // The throw is held, this block runs once, then rethrown below — a second copy in a catch
          // applies a decision twice. ONE failure is excluded: `LeaseUnavailableError`, the lease
          // read failing (not "another organizer holds it"). This channel appends acks and expunges
          // records, and its standing comes only from the lease, so it must not proceed on an
          // unanswered question; skipping costs a delay, the next pass drains once the lease reads.
          /* ── AND THE PERMIT'S OWN LAST VERDICT, WHICH IS NOT A CLASS OF THROW ─────────────
           *
           * A stand-down mid-drain revokes the permit, and only ONE of the drain's write sites
           * lets the refusal out: `fileOne`, `reconcileFlags` and `folderOpsPass` each swallow
           * everything but a fence, so the ordinary shape of this defect reaches here with
           * `cycleError` NULL and the pass reporting success. Asked of the permit instead, both
           * shapes are one fact. Only when this pass was ORGANIZING: a reader holds no permit and
           * its own channel below must not be refused by a receipt from before its demotion. */
          /* A write the lease declined at the command is the same NO for the tail, asked later. */
          const permitStoodDown = organizing && (leaseStoodDown(box.leasePermit) || box.drainDeclined);
          /* AND NOTHING AFTER A HAND-BACK: from the latch on this install writes nothing to
             `ohmail/_meta`, and every round trip here is one the release waits behind. */
          const cycleMayStillWrite = !permitStoodDown && !box.handedBack
            && !(cycleError instanceof LeaseUnavailableError
              || cycleError instanceof ConnectionReplacedError);
          if (cycleMayStillWrite) try {
            /* ── THE POST-DRAIN WRITES ARE ON THE GATED CONNECTION, AND ARE CHECKED FIRST ────
             *
             * Everything below appends to, acknowledges in, or expunges from `ohmail/_meta` — the
             * same folder the organizer lease lives in — and it all used to run on the MUTABLE
             * binding after the cycles had finished. A pass that gated connection A and reached
             * here after a re-dial installed B therefore did its request and profile writes on B,
             * whose own gate was still queued behind this very pass. Two installs writing one
             * mailbox's decisions, which is the invariant, reached without a single cycle
             * misbehaving — the cycle half was fixed and this half was not. */
            box.assertSameConnection(gen, conn);
            if (organizing) {
              await applyMetaRequests(
                scope.db, {
                  mailboxId: mb.id, accountId: scope.world.accountId, adapter: conn, installId: scope.installId,
                  requestKey: box.requestKey,
                }, scope.now(),
                noteRequestEvent,
              );
              // Rows this install queued while it was a READER are stranded the moment it becomes
              // the organizer: nothing appends them, and no acknowledgement will ever arrive
              // because the organizer they wait for is this process.
              await settleOwnOutstandingRequests(
                scope.db, { mailboxId: mb.id, accountId: scope.world.accountId }, scope.now(), noteRequestEvent,
              );
            } else {
              /* THE READER'S HALF OF THE SAME CHANNEL, checked on its own. The organizer arm above
                 has its own assertion and this branch is reached instead of it, never after it —
                 so borrowing that one would leave this path unguarded, which is precisely what the
                 census found. */
              box.assertSameConnection(gen, conn);
              await driveOutstandingRequests(
                scope.db, {
                  mailboxId: mb.id, accountId: scope.world.accountId, adapter: conn, installId: scope.installId,
                  requestKey: box.requestKey,
                },
                { installId: scope.installId, kind: scope.organizerKind }, scope.now(),
                noteRequestEvent,
              );
            }
          } catch (err) {
            scope.log("organizer_requests_drain_failed", {
              err, mailboxId: mb.id,
              reason: "this pass reads or organizes mail regardless; the next pass tries again",
            });
          }

          // The mail pass's own failure, now that the channel has had its turn. Everything below
          // is the tail of a pass that COMPLETED and must not run for one that did not.
          if (cycleError !== null) {
            await restOnInbox(gen, conn, cycleError);
            throw cycleError;
          }
          /* NOTHING MORE AFTER A HAND-BACK: the profile publish below writes `ohmail/_meta` too. */
          if (box.handedBack) return cycles;

          // The portable profile's write-behind tick, behind the gate it rides. After the drain,
          // it reads the store the cycles just wrote, so a burst of verdicts is one comparison.
          // Reachable only when `mayOrganize()` said yes — publishing into someone's `ohmail/_meta`
          // is the single-writer rule, not an optimisation. Runs on a zero-cycle drain too
          // (settings change without mail), never throws. EXPLICIT now the line above no longer
          // returns for a reader: this used to be organizer-only by being unreachable.
          /* THE PROFILE PUBLISH IS A MAILBOX WRITE TOO — an append and an expunge in
             `ohmail/_meta` — and it read the LIVE getter, so a stale pass published this
             install's settings over a connection it had never gated. Checked here; the sync
             itself resolves its adapter through the same getter, so the check is what stands
             between it and a replaced connection. */
          box.assertSameConnection(gen, conn);
          /* AND NOT IF THE PERMIT STOOD DOWN — the same fact the request channel above asks. The
             publish is an append and an expunge in `ohmail/_meta`, and it is reached on exactly
             the shape that hides the stand-down: a refusal swallowed inside the cycle leaves
             `cycleError` null, so the line above lets this run. `organizing` is the gate's answer
             from before the drain and says nothing about what happened during it. */
          if (organizing && !permitStoodDown) await box.profileSync.onOrganize(conn);
          await restOnInbox(gen, conn, null);
          return cycles;
        });

      /**
       * One drain, with the connection's health accounted for either way. This wrapper is the
       * SECOND detector, because the first is not reachable everywhere: `guardAsyncErrors` returns
       * early for a client with no event surface, so an injected double bypasses the `close`
       * listener — an event-only heal would be the `failure-looks-like-healthy` shape. It also
       * covers a half-open death that emits nothing. On the PUBLIC entry point, not inside
       * `serialize`, so the accounting sees the drain's OUTCOME and a direct caller ("sync now",
       * `syncMailbox`) feeds the same bound the poll timer does.
       */
      /**
       * DID THIS DRAIN PRODUCE ANYTHING ANYONE COULD SEE? The window runs its own mirror and learns
       * what exists ONLY from the change log it drains (`local-mirror.ts`), so the log's top seq is
       * exactly that question: one indexed aggregate over the `(account_id, seq)` primary key.
       * `"empty"` is a log with no rows — a real, quiet state, kept apart from `null`, which is a
       * log we could not read and which {@link noteIdleOutcome} treats as NOT quiet. The fail-safe
       * direction is the fast cadence.
       */
      const changeLogMark = async (): Promise<string | null> => {
        try {
          const { max } = await seqBounds(scope.db as unknown as Tx, scope.world.accountId);
          return max === null ? "empty" : max.toString();
        } catch {
          return null;
        }
      };

      /**
       * One step of the ladder, taken after a drain that came back. A drain that changed nothing
       * climbs towards the ceiling; one that changed something falls back to base. The climb needs
       * {@link restMayBeTaken} — resting behind a doorbell nobody wired would be trading freshness
       * for CPU, which is the fix this lane was told not to make.
       */
      const noteIdleOutcome = async (before: string | null): Promise<void> => {
        /* READ HERE, AND NOT TAKEN FROM THE DRAIN'S OWN CLOSING MARK, which is the obvious
           saving and is wrong: `drainPass` runs the REQUEST CHANNEL after the drain body returns,
           and `applyScreenerDecision`, `applyMessageMove`, `applyProfileUpdate` and
           `applyRuleRequest` all append change rows. A ladder holding the body's mark would rest
           two minutes over another install's request it had just applied. */
        const after = await changeLogMark();
        const quiet = before !== null && after !== null && before === after;
        if (!quiet) { box.idlePollMs = scope.pollIntervalMs; return; }
        /* A QUIET DRAIN UNDER THE ORGANIZER'S ROLE: the tenure's observed folders are up to date, so
           the gap catch-up may run at the next drain's head. */
        if (box.lastPassOrganizing) scope.gapCatchupReady.add(mb.id);
        if (!box.restMayBeTaken) return;
        const next = nextIdlePollMs(box.idlePollMs, scope.pollIntervalMs, scope.idlePollCeilingMs);
        if (next === box.idlePollMs) return;
        box.idlePollMs = next;
        scope.log("sync_idle_backoff", { nextPollMs: next, ceilingMs: scope.idlePollCeilingMs });
      };

      const syncUntilQuiet = async (
        maxCycles = 100,
        opts: { force?: boolean } = {},
      ): Promise<number> => {
        /* NOTHING IS DRAINED OVER AN ADAPTER THAT WAS NEVER ASKED TO CONNECT — see
           {@link launchSkipped}. A "Sync now" here drained over it, threw a TypeError the press's
           catch swallowed, and left the first-sync record saying the import produced nothing
           readable. Nothing to probe and nothing to re-dial either, so this comes before both. */
        if (box.launchSkipped) return 0;
        // THE HEAL, IMMEDIATELY BEFORE THE DRAIN IT IS FOR — and outside `drainPass`'s serialized
        // body, which would deadlock. See `redialIfDead`. It never throws: a server that is still
        // down leaves the drain below to fail in its own words, which is the class the bound
        // counts and every failure counter exempts.
        /* THE POLL PASSES NOTHING, so the ladder holds for it — `force` reaches here only from
           the resync route's wrapper, which is a person pressing a button. */
        /* The detector before the heal: `redialIfDead` returns while nothing is known dead, so a
           half-open link reached the drain and hung inside it. Never throws. */
        await box.heartbeat();
        await box.redialIfDead({ force: opts.force === true });
        /* A CONNECTION A READ BOUND RETIRED IS NEVER DRAINED: it refuses every call with the stale
           breach in milliseconds. Until the ladder lets the re-dial through, the cycle says so. */
        if (box.connectionDeadSince !== null && box.deadGeneration === box.generation && box.deadByBreach) {
          scope.log("mailbox_redial_deferred", {
            mailboxId: mb.id,
            attempt: box.redialAttempts,
            retryInMs: box.redialWait.left(),
            reason: "the server sent more than this install accepts and the connection was " +
              "retired; nothing is drained over it, and the next due poll dials a new one",
          });
          return 0;
        }
        /* AND NOTHING IS DRAINED OVER A CONNECTION THAT WAS NEVER OPENED. The poll is armed for a
           mailbox whose stored password could not be used so the READ is retried on the ladder —
           see `redialIfDead` — and a drain here would fail on every tick against an adapter that
           has never connected, filing `sync_cycle_failed` for a state the connection record
           already states. `0` is the honest count: nothing was served. */
        if (box.credentialBlock !== null) return 0;
        /* A PRESS IS ATTENTION. A forced drain — the resync button, a foreground resume, a
           promotion — returns the ladder to base on the way in and takes no rest on the way out,
           however little it finds: somebody is at the screen. */
        if (opts.force === true) box.idlePollMs = scope.pollIntervalMs;
        /* THE WINDOW'S FIRST PAGE GOES FIRST — once per process, bounded, and never in front of a
           press. A transaction is one admission in `store-lanes.ts`, so this drain's transactions
           would otherwise hold the one connection through the whole of the reader's cold start;
           `first-page-gate.ts` carries the measurements. A FORCED drain skips it: somebody is at
           the screen asking for mail, and they are not the reader this gate is for. */
        if (opts.force !== true) await scope.yieldToFirstPage();
        const markBefore = await changeLogMark();
        try {
          const cycles = await drainPass(maxCycles);
          box.noteCycleServed();
          if (opts.force !== true) await noteIdleOutcome(markBefore);
          return cycles;
        } catch (err) {
          /* A FAILED DRAIN IS NOT A QUIET ONE, and the bound this protects is one the app states
             in plain words: a connection is dead after 120 s OR after 8 consecutive cycles that
             could not read the lease, whichever comes first (see `LOCAL_CONNECTION_DEAD_AFTER_MS`
             and its cycle twin). Climbing the ladder here would stretch those eight cycles across
             sixteen minutes. */
          box.idlePollMs = scope.pollIntervalMs;
          /* A DRAIN THAT DIED LEFT THE STORE IN A STATE NOBODY STATED. `runSyncCycle` has already
             dropped the memo on its own throw; this forgets the MARK too, so the next drain
             re-reads rather than trusting a comparison against a moment that was never finished. */
          box.knownSetMark = null;
          box.noteCycleFailed(err);
          if (isDeviceStoreFault(err)) box.noteStoreFaultDrain();
          /* AND THE REFUSAL IS NAMED, once per settled attempt. `noteCycleFailed` already exempts
             it correctly — a tagged `NO` is not a connection failure and never advanced the bound
             — but it exempted it in SILENCE, so every poll after the launch left no line at all
             and a mailbox nothing could be read from looked like a mailbox with nothing in it. */
          if (fetchRefused(err)) box.noteFetchRefused(err);
          throw err;
        } finally {
          /* A DRAIN CAME BACK — HOWEVER IT CAME BACK. In a `finally` because the arm that
             matters most is the throwing one: a first sync that cannot read the mail leaves by
             the catch, and reading the state only off the returning arm would report the failure
             as a first sync still working, for ever. `stopped` is excluded for
             `noteCycleServed`'s reason — a runtime told to stop is evidence about nothing. It
             never throws (the tracker contains its own probe's faults), so it cannot replace the
             error this block is carrying out. */
          if (!box.stopped) await box.firstSync.noteDrainEnded(() => mirroredFirstSyncFacts(scope.db, mb.id));
        }
      };

      const schedule = (delayMs?: number): void => {
        /* AND NOT AFTER A HAND-BACK: a drain's `.finally(schedule)` would re-arm the poll the
           latch just cleared. `resume()` clears the latch before it asks. */
        if (box.stopped || box.handedBack) return;
        /* A KICK OUTRANKS AN ORDINARY RE-ARM, and that is a correctness rule rather than a
           preference. `delayMs === undefined` is the tail of a drain; a drain settling just after
           an arrival rang would otherwise clear the kick's timer, put that mail behind a full
           interval, and leave `wakePending` set for ever so no later arrival could ring either.
           The kick's own callback clears the flag. */
        if (delayMs === undefined && box.wakePending) return;
        /* EXACTLY ONE POLL TIMER PER RUNTIME, at any moment. Every armed timer re-arms itself in
           the `.finally` below, so arming a second one does not move the next poll — it starts a
           second loop that runs for the life of the runtime, and two gated cycles then race each
           other on the lease. A caller that arms while one is armed MOVES the next poll instead.
           `dialAndGate` says the same about itself ("two would give the mailbox two overlapping
           drains"); the enforcement belongs here, where the timer is. `stopped` returns first. */
        if (box.timer) clearTimeout(box.timer);
        const kick = delayMs === 0;
        /* A RE-DIAL AFTER A SET-ASIDE IS DUE AT THE LADDER'S FIRST STEP, so the next poll comes AT
           it: earlier would be deferred and then wait a whole interval, later is the idle ladder
           taxing progress. Nothing is drained meanwhile (the connection is retired). A floor in
           the past is spent. */
        const floorLeft = box.floorPoll.left();
        if (floorLeft === 0) box.floorPoll.clear();
        const due = delayMs ?? (floorLeft > 0 ? floorLeft : box.idlePollMs);
        box.timer = setTimeout(() => {
          /* SPENT THE MOMENT IT FIRES, before anything can await. Left standing, the guard above
             refuses every later re-arm and the mailbox stops polling altogether after its first
             arrival — which is how this line came to exist (the reset case went red on a poll loop
             that had silently ended). */
          box.wakePending = false;
          if (kick) box.ringQueued = true;
          void syncUntilQuiet()
            .catch((err: unknown) => {
              // A failed cycle is a bad network or a sleeping laptop, not a reason to stop being a
              // mail app. Offline is a property of this mode: the organizer pauses and the viewer
              // stays complete — the API keeps serving the mirror over the bridge either way.
              /* Except when what failed was the LEASE, which is not a passing condition. A cycle
               * that died because `ohmail/_meta` could not be read is the organizer half of the
               * reader case beside it: the install organizes nothing until it clears and says so.
               * Narrowed BY CLASS — arming this for every cycle failure would make a dropped
               * connection look like an unreadable lease and the field would stop meaning anything.
               * Cleared by the next successful gate, like the other paths. */
              box.markLeaseRefused(err);
              // A store mark thrown outside the drain (the gate's own reads) raises the sentence too.
              box.deadLetters.settleStoreFault(err);
              // Which of our ceilings ended it, as the hosted worker's line says; null otherwise.
              const ceiling = isImapBoundExceeded(err) ? err : null;
              scope.log("sync_cycle_failed", {
                err, ceiling: ceiling?.bound ?? null, ceilingLimit: ceiling?.limit ?? null,
              });
            })
            /* A kick whose drain never reached `drainPass` (a skipped launch, a blocked
               credential) must not leave every later ring answering "already queued". */
            .finally(() => { if (kick) box.ringQueued = false; schedule(); });
        }, due);
        box.timerDueAt = scope.monotonic() + due;
        box.timer.unref?.();
      };

      /**
       * THE DOORBELL RANG — INBOX grew. Two acts and no more: the ladder returns to base (the
       * mailbox is active again) and one drain is armed for now. Synchronous and throw-free by
       * construction: it runs inside imapflow's `exists` handler, where a raising listener is the
       * uncaught exception the connection's own listeners exist to prevent.
       */
      const onMailboxSignal = (): void => {
        if (box.stopped || box.handedBack) return;
        box.idlePollMs = scope.pollIntervalMs;
        if (box.wakePending || box.ringQueued) return;
        box.wakePending = true;
        schedule(0);
      };

      /**
       * A DOOR WROTE SOMETHING — see {@link LocalMailboxRuntime.noteWorldMoved}. The ladder goes
       * back to base, and the armed timer is pulled in ONLY if that lands sooner than what is
       * already due. No drain is forced: the guarantee is "within one base interval", which is
       * exactly the cadence this engine had before it learned to rest.
       */
      const noteWorldMoved = (): void => {
        if (box.stopped || box.handedBack) return;
        box.idlePollMs = scope.pollIntervalMs;
        if (box.wakePending) return;
        if (box.timerDueAt - scope.monotonic() > scope.pollIntervalMs) schedule(scope.pollIntervalMs);
      };

      /**
       * A READ PRESS GOES TO THE SERVER NOW — see {@link withSeenPush}. One `\Seen`-only pass with
       * the reader's entitlement (no lease read, no folder walk, no move), queued behind this
       * mailbox's drains so a read and a later unread never cross on the wire. The latch clears
       * when the push STARTS, so a press during it queues exactly one more and the last press wins.
       * Anything that stops a drain stops this too; the next drain then carries the rows.
       */
      const pushSeen = (): void => {
        if (box.stopped || box.handedBack || box.seenPushQueued) return;
        box.seenPushQueued = true;
        const askedAt = scope.monotonic();
        void box.serialize(async () => {
          box.seenPushQueued = false;
          if (box.stopped || box.handedBack) return;
          if ((await scope.repo.listPendingFlagStates(mb.id, 1)).length === 0) return;
          if (box.stopped || box.handedBack || box.signedOutSinceDial() || box.launchSkipped || box.credentialBlock !== null
            || box.connectionDeadSince !== null) return;
          const gen = box.generation;
          const conn = box.adapter;
          if (box.loginGeneration !== gen) { onMailboxSignal(); return; }   // no login on this dial yet
          const startedAt = scope.monotonic();
          box.assertSameConnection(gen, conn);
          const { owesFiling: owesMore } = await runSyncCycle({
            ...box.syncDeps, adapter: conn, repo: scope.repo, knownSet: box.knownSet, signatures: null, seenOnly: true,
            role: "reader", writeAuthority: cycleWriteAuthority("reader", box.leasePermit),
          });
          await restOnInbox(gen, conn, null);
          scope.log("seen_push", {
            mailboxId: mb.id, waitedMs: Math.round(startedAt - askedAt),
            totalMs: Math.round(scope.monotonic() - startedAt), more: owesMore,
          });
          if (owesMore) onMailboxSignal();
        }).catch((err: unknown) => {
          scope.log("seen_push_failed", {
            mailboxId: mb.id, err,
            reason: "a read or unread press could not be sent at once; it stays owed and the next "
              + "drain sends it",
          });
        });
      };

      /**
       * ══ ARM THE DOORBELL — the channel this door has always had and never used ══
       *
       * `watch` is required of every `MailboxAdapter` and the hosted worker has run on it since
       * 0.13; here it is what LETS the poll rest, so it is measured rather than assumed — the rest
       * is taken only when the listener is registered AND the server advertises IDLE. Best-effort
       * by construction: a refusal leaves `restMayBeTaken` false and this mailbox on its old base
       * cadence, which is a slower app and never a wrong one. Per DIAL — a re-dial re-arms.
       */
      const armWake = async (conn: MailboxAdapter): Promise<void> => {
        /* EXACTLY ONE LISTENER PER RUNTIME, the poll timer's own rule applied to the doorbell: the
           previous one is detached before a new one is registered, so a re-dial cannot leave two
           subscriptions ringing one mailbox. */
        const previous = box.unwatch;
        box.restMayBeTaken = false;
        box.unwatch = null;
        if (previous) await previous().catch(() => { /* that connection is already gone */ });
        try {
          const caps = await conn.capabilities();
          if (!caps.idle) {
            scope.log("local_wake_unarmed", {
              reason: "this server does not advertise IMAP IDLE, so there is no channel to rest " +
                "behind; the poll keeps its base interval and carries every arrival itself",
            });
            return;
          }
          box.unwatch = await conn.watch(onMailboxSignal);
          box.restMayBeTaken = true;
        } catch (err) {
          scope.log("local_wake_unarmed", {
            err,
            reason: "the INBOX watch could not be armed on this connection, so the poll keeps " +
              "its base interval and carries every arrival itself",
          });
        }
      };
      box.changeLogMark = changeLogMark;
      box.syncUntilQuiet = syncUntilQuiet;
      box.schedule = schedule;
      box.onMailboxSignal = onMailboxSignal;
      box.noteWorldMoved = noteWorldMoved;
      box.pushSeen = pushSeen;
      box.armWake = armWake;
}
