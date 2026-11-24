import { ImapConnectionClosedError } from "@trafficflow/core/adapters/imap";
import { recordSpecialFolders } from "@trafficflow/core/adapters/drizzle-repo";
import { PlaintextDialRefused } from "@trafficflow/api/local";
import { breachSetAside } from "@ohmail/organizer/dead-letter";
import { LeaseUnavailableError, writeDoorOf, leaseBlockReason } from "@ohmail/organizer/lease";
import { firstPageDoorArmed } from "./first-page-gate.js";
import type { LocalRosterRow } from "./identity.js";
import { releaseOwnClaim } from "./engine-local-services.js";
import { SignedOutError } from "./engine-reconnect.js";
import {
  certificateRefused, dialWentQuiet, credentialsRefused, fetchRefused, isConnectionFailure,
  drainFailureKeepsTheLogin,
} from "./engine-classifiers.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope, ReconnectProof } from "./engine-mailbox-scope.js";

/**
 * The desktop's engine, one section: one mailbox's dial: the dial with its gate, and the redial of a dead
 * connection.
 */
export function dialSection(scope: EngineScope, box: MailboxScope, mb: LocalRosterRow): void {
      /**
       * THE RUNTIME THIS MAILBOX IS, handed to the roster.
       *
       * The thirteen mutable fields are ACCESSORS rather than copies, and that is the whole of
       * the care this record needs. `mayOrganize` writes `organizer`, `priorStandDown` and
       * `leaseNonce` on every pass; a record built by spreading their values would freeze the
       * answers at attach time, so the pane would render a demotion that happened an hour ago as
       * though this install still organized the mailbox. Reading through a getter is what keeps
       * the map's view and the gate's view the same view.
       */
      /** Set only while {@link launch} waits: called once the launch's login has opened. */
      box.onDialled = null;

      /**
       * Dial, then learn, then act — the ONE sequence a launch and a re-dial both run. Extracting
       * it from `start()` is what makes reconnect safe: resuming a drain over a fresh socket
       * WITHOUT re-reading the organizer lease would dual-organize against a claim that arrived
       * during the outage, and reconnect-after-sleep is when a mailbox most likely changed hands.
       * "Exactly one active organizer per mailbox" — a second copy of this sequence is how it
       * breaks. The lease is read BEFORE the first move, and `ensureFolders` IS a move. It does NOT
       * arm the poll timer: `start()` calls `schedule()` after it, and a re-dial's chain already
       * ends in one — two would give the mailbox two overlapping drains.
       */
      const dialAndGate = async (): Promise<{ leaseRead: boolean; drainError?: unknown }> => {
        /* THE SIGN-OUT FENCE, BEFORE `connect()` and before anything else. A launch and a re-dial
           both come through here, and both hold the plaintext in memory — so a sign-out that
           landed after this mailbox resolved its password must stop the login being opened, not
           merely the row being read. Refusing is the whole act: the poll timer lands here again
           and refuses again until the process ends or somebody signs back in. */
        if (box.signedOutSinceDial()) throw new SignedOutError();
        await box.pinPlaintextDial(box.imapConfig);
        await box.adapter.connect();
        /* The login is open: a press waiting on this launch has its answer ({@link launch}). */
        box.onDialled?.();
        /* AFTER `connect()`, because that is the call that establishes the connection this pass
           is about. Captured once and carried, exactly as `drainPass` does. */
        /* STOPPED WHILE WE DIALLED. `connect()` is the longest await in this sequence and
           `detach()` can complete inside it, so the gate below — which APPENDS a claim to the
           user's mailbox — must not be reached by a runtime that has been told it is finished. */
        /* CAPTURED FIRST, BEFORE THE STOPPED CHECK — and the order is the point rather than
           tidiness. This close exists to release the login THIS sequence just opened, so it must
           name that connection and not the binding, which a re-dial can move. Capturing after the
           check left one `adapter.close()` inside the gated region, which is the receiver-position
           shape the census now refuses. */
        const gen = box.generation;
        const conn = box.adapter;
        if (box.stopped) {
          await conn.close().catch(() => { /* already going away */ });
          return { leaseRead: false };
        }
        box.loginGeneration = gen;
        // Everything below runs on an AUTHENTICATED socket, so it is wrapped. `connect()` logs in
        // then LISTs, and `main.ts` answers a rejected `start()` by logging and serving the mirror
        // anyway — so a throw from the lease gate, `ensureFolders` or the first drain left an
        // authenticated login open with no handle to close it, for the life of the process. iCloud
        // caps concurrent connections per account, so a leaked login eventually refuses connects in
        // another app. A `catch` and NOT a `finally`: a healthy launch keeps the login (the poll
        // timer and organizer claim run on it); tests assert both directions. Same close-then-
        // rethrow shape as `send-adapter.ts` and `attachments-adapter.ts`.
        try {
          // The lease is read BEFORE the first move, and `ensureFolders` IS a move: creating the `ohmail`
          // folder tree in a mailbox Cloud organizes is a write this install has no business making, and
          // reconnect-after-sleep is when a mailbox most likely changed hands. Gated here, drained through
          // the already-gated inner `drain`, so a launch reads the lease ONCE. A lease we could not READ is
          // not one we lost: an unreachable `ohmail/_meta` leaves the organizer paused and the viewer
          // complete rather than a failed launch, exempted BY CLASS as the hosted worker does. The login is
          // KEPT — it is the connection the next poll asks over and the one non-throwing exit here with
          // further work to do.
          let permitted: boolean;
          try {
            permitted = await box.serialize(box.mayOrganize);
          } catch (err) {
            if (!(err instanceof LeaseUnavailableError)) throw err;
            await box.shrinkRefusedMeta(err, conn);
            // `err` and not `err.message`, and this is the sharpest case for that rule:
            // `LeaseUnavailableError` is constructed with `{ cause: err }` around an ImapFlow
            // failure, so its message quotes the folder and the driver's response. The logger
            // reduces it to `errorClass: "LeaseUnavailableError"` — which is the exemption this
            // catch block is ABOUT, so the log now names the class the code branched on.
            scope.log("start_lease_unavailable", {
              err,
              reason: "the organizer lease could not be read, so this install organizes nothing " +
                "yet; the mirror is served and the next poll asks again",
            });
            /* AND IT IS RECORDED WHERE A PERSON CAN SEE IT — carried over from the launch
             * sequence this function was extracted from. A log line is not a user-visible state,
             * and when the cause is a folder over the ceiling it does not clear on its own, so a
             * desktop would otherwise sit in an ordinary connected state organizing nothing. Kept
             * from the FIRST failure rather than refreshed, so a surface can say how long it has
             * been true; every path that reads the lease successfully sets it back to `null`.
             *
             * THE LEASE, NOT THE SOCKET. A dead connection has its own clock
             * (`connectionDeadSince`) and must never land here: "we cannot read who organizes this
             * mailbox" and "this machine cannot reach the server" are different sentences. */
            box.organizer = {
              organizing: false,
              reason: box.organizer.reason,
              heldBy: box.organizer.heldBy,
              unreadableSince: box.organizer.unreadableSince ?? new Date().toISOString(),
              unreadableReason: leaseBlockReason(err),
              /* CARRIED with the rest: an unreadable lease says nothing about the row — and that
                 is the whole of it for `claimed`. An outage is not a machine taking the mailbox,
                 so the notification stands and the next poll asks again. */
              releaseRequestedAt: box.organizer.releaseRequestedAt,
              claimed: box.organizer.claimed,
              releaseRefusal: box.organizer.releaseRefusal,
              holderState: box.organizer.holderState,
            };
            // NO `schedule()` HERE — the CALLER arms the timer. That is what lets a re-dial
            // run this identical sequence without arming a second one for the same mailbox.
            //
            // `leaseRead: false` — THE SOCKET IS UP AND THE MAILBOX IS NOT BEING ORGANIZED, and
            // the caller must be able to tell those apart. A re-dial that reported success here
            // cleared the outage, logged `mailbox_reconnected` and told the person their mailbox
            // was healthy while nothing was being filed.
            return { leaseRead: false };
          }
          /* `!permitted` is "NOT THE ORGANIZER", not "stop" — the launch half. This used to
           * `return`, taking the first drain, special-folder discovery AND `schedule()` with it,
           * so a stood-down install came up with no poll timer (and closed the login on
           * `priorStandDown`). A stand-down no longer means stop: a demoted install is a READER —
           * it keeps its login and poll timer and goes on cycling, so the gate re-runs next poll,
           * reads the stamp and promotes with no relaunch (without which "Organize from this
           * machine" did nothing until restart). So a reader falls through — drains, schedules,
           * keeps the connection — and the one thing it does not do is below. */
          /* `stopped` is checked whatever the gate answered. This read `if (!permitted && stopped)`,
           * so a gate that said YES walked past it — and `mayOrganize` is the longest await, the
           * likeliest place for `detach()` to land. A removal or shutdown overlapping a slow lease
           * read then continued into `ensureFolders`, discovery and a full drain on a runtime told
           * it was finished, having already appended a fresh claim. `detach()` waited for all of it:
           * it bounded the damage's duration and prevented none. The permitted arm STANDS DOWN
           * rather than returning — the gate just renewed a claim on a mailbox it is letting go, and
           * leaving it makes the next install wait out a claim nobody honours. */
          if (box.stopped) {
            if (permitted) {
              const released = await releaseOwnClaim(
                conn, scope.installId, mb.id, { current: box.leaseNonce, minted: box.leaseMinted }, scope.log,
                "the claim this pass renewed could not be released; it ages out of " +
                  "ohmail/_meta on its own and another install takes the mailbox then",
              );
              /* ONLY WHEN SOMETHING WAS ACTUALLY GIVEN BACK. This line was written
                 unconditionally and the release's answer was discarded, so a pass that removed
                 NOTHING — the folder held no record of ours the search could see — still said the
                 claim "is given back rather than left to age out". Its two siblings on this door
                 both gate on the count; this one did not, and it is the arm that runs on the
                 detach a person's removal triggers, which is exactly when the sentence gets read.
                 A sibling refusal is not a count either: nothing was given back (mail 0121). */
              if (typeof released === "number" && released > 0) {
                scope.log("organizer_claim_released_on_detach", {
                  mailboxId: mb.id,
                  claims: released,
                  reason: "the mailbox was removed or the engine stopped while the organizer " +
                    "lease was being read, and that read had already renewed this install's " +
                    "claim; it is given back rather than left to age out",
                });
              }
            }
            return { leaseRead: true };
          }
          /* AND THERE IS NO SECOND `stopped` CHECK BELOW THIS, DELIBERATELY.
           *
           * `if (!permitted && stopped)` stood here, returning the same `{ leaseRead: true }` for
           * the removal case. The arm above returns on `stopped` whatever the gate answered, so
           * its contrary state — stopped, and not yet returned — is unreachable: the condition
           * could never be true, could never be watched fail, and read to the next person as a
           * promise this code does not keep. The removal case it named is handled by the arm
           * above, on the same `leaseRead: true`, and `mayOrganize` has already cleared the timer
           * and closed the login on that path.
           */
          // Before the first cycle of an ORGANIZER, always: the pipeline routes into the `ohmail`
          // folder tree, and a move to a folder the server does not have fails. The hosted sync
          // worker does the same thing at attach time.
          //
          // NEVER FOR A READER, and this is the sharpest line in the branch above: `ensureFolders` is the
          // IMAP WRITE that creates somebody else's `ohmail` tree, and the header forty lines up already says
          // so — *"reconnect is learn-then-act … creating the `ohmail` folder tree in a mailbox Cloud is
          // organizing is a write this install has no business making"*. It was gated by the `return` that
          // has just gone, so it needs its own gate now.
          if (permitted) {
            /* THE CONNECTION THIS DIAL ESTABLISHED, not the binding. `dialAndGate` captures
               `conn` immediately after `connect()`, and every `await` between there and here —
               the lease read most of all — is a window in which a re-dial can move the binding.
               Creating somebody else's `ohmail/*` tree through a connection this sequence never
               gated is the defect the cycles were fixed for, on the launch path. */
            box.assertSameConnection(gen, conn);
            await conn.ensureFolders(writeDoorOf({ lease: box.leasePermit }));
            // See {@link foldersEnsured}: the poll's own call must not repeat what this just did.
            box.foldersEnsured = true;
          }
          // Mail 0065: discover the provider's own \Junk and \Trash and write them down. The
          // hosted worker's attach hook, mirrored here because the LOCAL engine is its own attach
          // path — without it `mailboxes.trash_folder` stays NULL, so delete refuses
          // (`no_trash_folder`) and spam verdicts never reach Junk. Read-only (one LIST), re-written
          // every attach so a renamed folder heals, best-effort (`imap-types.ts` carries the rule).
          // A READER runs it too: one LIST and a write to this install's own row, and the knowledge
          // makes a promotion take effect on the next poll rather than the next launch.
          // Mail 0132: the Sent path the scan watches, beside them — the worker's one write.
          try {
            await recordSpecialFolders(conn, scope.repo, mb.id);
          } catch (err) {
            scope.log("special_folder_discovery_failed", { err });
          }
          /* ── A FETCH THE SERVER REFUSED IS NOT A FAILED LAUNCH ──────────────────────────
           *
           * The lease arm's exemption above, one command later: the socket is up, the login
           * stands, the lease has been read, and what failed is the WORK. Rethrowing put the
           * launch through two call sites that both assume the socket — this function's `catch`,
           * which closes the login it just opened, and `start()`'s, which records a dead
           * connection for any launch failure. Measured on both doors against a relay answering
           * content FETCHes with a tagged `NO`: the mailbox read `reachable: false` and the app
           * said "Connection lost. Reconnecting…". So the login is KEPT, the caller arms the poll,
           * and the next drain asks again over the same connection. Narrow BY CLASS. */
          /* AND A DRAIN THAT FAILED FOR ITS OWN REASONS IS NOT A DEAD CONNECTION EITHER: a store
             refusal, a pipeline fault. The login is kept and the failure handed back, so the caller
             arms the poll over this connection and records no outage; only a connection-class
             failure, or our own refusal of a replaced connection, closes it. */
          let drainError: unknown;
          /* THE LAUNCH DRAIN WAITS FOR THE WINDOW'S FIRST PAGE TOO: its first cycle reads every
             locator of the mailbox (in pages, a turn of the loop each, but the whole mailbox), and
             only the poll's drain asked the gate. Bounded by the grace armed at serving; a re-dial
             after the page, or after the grace, waits nothing and
             logs nothing. Only where a door armed it: the phone serves no such page. A stop during
             the wait drains nothing; `detach()` gives the claim back. */
          if (firstPageDoorArmed()) await scope.yieldToFirstPage();
          if (box.stopped) return { leaseRead: true };
          try {
            // `permitted`, the answer THIS launch's gate gave — the launch is a pass like any
            // other and its drain runs under the role that pass read.
            await box.serialize(() => box.settledDrain(100, gen, conn, permitted));
          } catch (err) {
            if (fetchRefused(err)) box.noteFetchRefused(err);
            else if (drainFailureKeepsTheLogin(err)) drainError = err;
            else throw err;
          }
          /* THE DOORBELL, AFTER THE LAUNCH DRAIN AND BEFORE THE CALLER ARMS THE TIMER. After the
             drain so a first import is not interrupted by its own arrivals, and here rather than
             in `start()` so a RE-DIAL re-arms on the new connection — the watch belongs to the
             socket, and a mailbox that came back from an outage must not rest behind a doorbell
             that died with the old one. */
          /* Not over a connection that died in this gate: the watch would be asked of a retired
             connection; the re-dial arms it on the next one. */
          if (box.deadGeneration !== gen) await box.armWake(conn);
          // (the poll timer is armed by the caller — see the header)
          return drainError === undefined ? { leaseRead: true } : { leaseRead: true, drainError };
        } catch (err) {
          // The ORIGINAL error, rethrown — `main.ts` decides what a failed launch means, and it
          // must not be told the connection failed to close when what failed was the drain.
          /* `conn` AND NOT `adapter`, the same late-binding fault `noteConnectionDead` documents:
             this line exists to release the login THIS sequence opened, and after a re-dial the
             binding is a different, healthy connection — closing that one would retire the
             replacement on the way out of a failure that had nothing to do with it. */
          await conn.close().catch(() => { /* the connection is already broken */ });
          throw err;
        }
      };

      /**
       * Re-dial a connection known dead. It must NOT be called from inside the serial queue:
       * `serialize` chains onto `tail` and `dialAndGate` takes the queue twice, so a re-dial from
       * inside `drainPass` waits for itself — the deadlock this lane is about. So it runs on the
       * PUBLIC entry point, before the drain it heals. A FRESH adapter, not a re-opened one: a
       * bound-retired adapter refuses every call by design (`assertUsable`) and a fresh dial is the
       * only externally observable "opened a new connection". It NEVER throws (a dial error would
       * replace the `LeaseUnavailableError` the bound exempts), and a failed attempt does NOT reset
       * `connectionDeadSince` — Settings renders it as "unreachable since".
       */
      box.redialling = false;
      /**
       * THE IN-FLIGHT RE-DIAL, for `detach()` to wait on — and for nothing else to wait behind.
       *
       * Resolved whenever no re-dial is running, so awaiting it is free in the ordinary case.
       */
      box.redialInFlight = Promise.resolve();
      /**
       * @param force A person pressed "Sync now". Skips the backoff WAIT and nothing else: the ladder is
       * right for a poll, wrong for a person watching the one control do nothing after the network
       * returned. Every other early return still holds — `stopped` and `connectionDeadSince === null`
       * (nothing to re-dial), `redialling` (join, don't open a second login), the credential arm (which
       * retries the stored READ rather than dialling), and `signInRefused` (the SERVER said no; a press
       * must not become repeated LOGIN attempts providers throttle or lock). It does NOT reset the
       * ladder (`redialAttempts` untouched) and is NOT unlimited — at most once per this profile's first
       * ladder step ({@link forcedWait}, {@link ReconnectProfile}).
       */
      const redialIfDead = async ({ force = false }: { force?: boolean } = {}): Promise<void> => {
        if (box.stopped || box.connectionDeadSince === null || box.redialling || box.moving) return;
        /* ── A REFUSED SIGN-IN IS NOT RETRIED, AND A FAILING SERVER IS BACKED OFF ────────────
         *
         * Both are the same defect seen from two sides: a dial that cannot succeed being repeated
         * on the poll's cadence. The first cannot succeed until a person acts, so it is not
         * attempted at all; the second may, so it is attempted on a widening interval instead of
         * four times a minute. */
        if (box.signInRefused) return;
        /* A REFUSED CERTIFICATE WAITS FOR A PERSON, not for the ladder — see the field. */
        if (box.certificateRefusedNow && !force) return;
        /* THE PRESS SKIPS THE LADDER, AND THE FLOOR UNDER THE PRESS IS ITS OWN. See
           {@link forcedWait}: a forced dial that failed a moment ago has not become worth
           repeating because somebody pressed again. ABOVE the credential arm below, because the
           READ is rationed by this same ladder: a store that answered a moment ago has not become
           worth asking again either, and a read every poll would climb no ladder at all. */
        if ((force ? box.forcedWait : box.redialWait).left() > 0) return;
        /* THE SAME PRECONDITION `start()` KEEPS, and for the same reason: an empty password is a
           login attempt the server will refuse, and a refused login counts toward a lockout on
           some providers. A mailbox with no usable credential is not unreachable, it is waiting
           for a person, and dialling it repeatedly would turn that into a locked account.
           WHAT IS RETRIED IS THE READ, which touches no server: the row can open on a later read
           — a person re-entered the password on a door that does not replace this runtime — and
           without this the mailbox stayed dark until the app was quit. A read that does not open
           climbs the ladder exactly as a failed dial does. */
        if (box.login.state !== "ready" || !box.login.pass) {
          if (!(await box.rereadCredential())) {
            /* AND ONLY THE POLL CLIMBS, exactly as the failed dial below decides it: a press is
               one reading, not evidence about when a store might open, so it arms its own floor
               and leaves the automatic wait where it was. */
            if (force) box.forcedWait.arm(scope.reconnect.ladderMs[0]!);
            else box.climbTheLadder();
            return;
          }
          if (box.stopped) return;
          /* AND THE HEARTBEAT THIS LAUNCH NEVER ARMED. `start()` returned before `armHeartbeat()`
             when the password could not be used, so a mailbox healed here would run with two death
             detectors where every other one has three — and the missing one is the half-open link,
             which neither of the others describes. Reached at most once: the guard above is false
             from the moment the read opens. */
          box.armHeartbeat();
        }
          /* The re-dial joins `tail` so `detach()` waits FOR it, but is not put INTO it. It cannot
           * queue behind `tail` — `dialAndGate` takes the queue twice, so a queued re-dial waits
           * for itself (this lane's deadlock). But `detach()` awaits `tail` then closes the adapter,
           * so a re-dial outside it could resume afterwards: a fresh connection, a renewed claim and
           * folders for a just-removed mailbox, or a login with no handle to close it. Folding it
           * INTO `tail` deadlocks the other way (every later step, including the gate it waits for,
           * waits for it). So the wait gets its OWN handle: `detach()` awaits the queue AND this,
           * and this chains onto nothing. */
        box.redialling = true;
        let settle: () => void = () => {};
        box.redialInFlight = new Promise<void>((resolve) => { settle = resolve; });
        const deadSince = box.outageSince ?? box.connectionDeadSince;
        const detectedBy = box.connectionDeadBy;
        let proof: ReconnectProof | null = null;
        try {
          const old = box.adapter;
          /* The dead connection is DESTROYED, not asked to leave politely. `close()` issues a
             LOGOUT, and IMAP commands are serialized, so it queues behind a command already hung
             and waits out the hang it was escaping ({@link MailboxAdapter.forceClose}). On a
             half-open link (the socket answers TCP, nothing answers IMAP) the LOGOUT never settles,
             `finally` never runs, and `redialling` — the latch every later attempt returns on — is
             held for the life of the process, so no dial ever happens again. This and the
             detector's teardown are ONE mechanism: destroying the socket is what ends the other's
             hung LOGOUT, so with both polite there is no dial at all and neither may be relaxed on
             the grounds that the other covers it. */
          if (old.forceClose !== undefined) {
            try { old.forceClose(); } catch { /* the socket is going away regardless */ }
          } else {
            /* An injected double with no `forceClose`. NOT awaited, for the reason above: a
               teardown this function waits on is a latch this function can park on, and nothing
               below needs the old connection's last byte. */
            try { void Promise.resolve(old.close()).catch(() => undefined); }
            catch { /* threw synchronously; it is going away either way */ }
          }
          /* RE-CHECKED AFTER EVERY AWAIT, not once at the top. `detach()` can complete inside any
             of these suspensions — a mailbox removal, a password re-attach, the engine shutting
             down — and each check below is a point at which this stops rather than installing a
             connection for a runtime that has been told it is finished. */
          if (box.stopped) return;
          box.adapter = box.dialAdapter();
          proof = { deadSince, detectedBy, served: false };
          box.reconnectProof = proof;
          const outcome = await dialAndGate();
          if (box.stopped) {
            /* Removed while we dialled. The connection we just opened has no owner, and leaving
               it would be the leak `start()`'s own catch exists to prevent — on a provider that
               caps concurrent logins, in somebody else's mail app. */
            await box.adapter.close().catch(() => { /* already going away */ });
            return;
          }
          /* THE CONNECTION THIS RE-DIAL OPENED DIED INSIDE ITS OWN GATE — a read bound retired
             it. If the breach set its message aside, that is progress: no ladder step, no outage,
             and the next re-dial at the first step. Otherwise the catch below climbs the ladder;
             either way the death stays on record so the next due poll dials again. */
          if (box.deadGeneration === box.generation) {
            if (breachSetAside(outcome.drainError, box.deadLetters)) {
              /* The handshake went through, so the success branch's resets below hold here too: a
                 refused certificate or plaintext server is no longer the answer, and the press's
                 floor goes with the ladder. */
              box.certificateRefusedNow = false;
              box.plaintextRefusedNow = false;
              box.forcedWait.clear();
              box.redialAttempts = 0;
              box.redialWait.arm(box.jittered(scope.reconnect.ladderMs[0]!));
              box.outageSince = null;
              box.idlePollMs = scope.pollIntervalMs;
              box.floorPoll.arm(box.redialWait.left());
              box.schedule();
              scope.log("mailbox_redial_after_set_aside", {
                mailboxId: mb.id,
                attempt: box.redialAttempts,
                retryInMs: box.redialWait.left(),
                skipped: box.deadLetters.skipped,
                reason: "the connection was retired after a message the server sent more of than it " +
                  "declared was set aside, or the mail read before a batch overrun was kept; that " +
                  "is progress, so the next re-dial waits the first step and no outage is reported",
              });
              return;
            }
            throw outcome.drainError ?? new ImapConnectionClosedError();
          }
          /* The socket is up. That is not the same as the mailbox being served.
           * `connectionDeadSince` clears either way — it is what makes the next poll re-dial, and
           * re-dialling over an answering server would churn logins a provider counts. `outageSince`
           * clears only when a cycle is actually SERVED (`noteCycleServed`'s job, not this one), so
           * a re-dial that reached a live server but an unreadable `ohmail/_meta` leaves Settings
           * saying "unreachable since" the ORIGINAL instant — the outage is not over. */
          box.connectionDeadSince = null;
          box.connectionDeadBy = null;
          box.wentQuiet = false;
          box.redialAttempts = 0;
          box.redialWait.clear();
          /* The handshake went through, so the certificate is no longer the answer. */
          box.certificateRefusedNow = false;
          box.plaintextRefusedNow = false;
          /* The press's floor goes with the ladder — DEFENCE, not a watched invariant, said here
           * so a later reader does not take it for a guarantee. Its contrary state is unreachable:
           * a FORCED dial runs only once the floor has passed, so a later press is admitted whether
           * or not this clears it. The one path that could differ (a poll succeeding inside the
           * window) needs pinned jitter and a frozen clock and loses the lease
           * (`lease_lost_race`), so a case on it was a race, not evidence, and was removed. Kept as
           * hygiene — a floor outliving the condition it rations is a bug for the next caller — and
           * the mutation table leaves it out. */
          box.forcedWait.clear();
          if (outcome.leaseRead) {
            box.leaseUnavailableSince = null;
            box.leaseUnavailableCycles = 0;
            // Already said at its first served cycle; this is a drain that served none.
            if (!proof.served) scope.log("mailbox_reconnected", {
              mailboxId: mb.id,
              detectedBy: detectedBy ?? "bound",
              totalMs: deadSince ? Date.now() - deadSince.getTime() : 0,
              reason: "the mail server connection was re-opened and the organizer lease was read " +
                "again BEFORE anything was moved, so a claim that arrived during the outage is " +
                "honoured on the first cycle back rather than a cycle later",
            });
            // The connection is back; its first drain failed for a reason of its own.
            if (outcome.drainError !== undefined) {
              scope.log("sync_cycle_failed", { err: outcome.drainError, ceiling: null, ceilingLimit: null });
            }
            return;
          }
          /* THE STREAK IS DELIBERATELY NOT CLEARED. The lease is still unreadable, so the cycles
             that follow are a CONTINUATION of the same outage rather than the start of a new
             one — clearing it would buy the wedge another full bound before anybody looked
             again. */
          scope.log("mailbox_reconnect_lease_unavailable", {
            mailboxId: mb.id,
            totalMs: deadSince ? Date.now() - deadSince.getTime() : 0,
            reason: "the connection was re-opened and the organizer lease still could not be " +
              "read, so this install organizes nothing yet and the mailbox is still reported " +
              "unreachable. The socket is not the mailbox",
          });
        } catch (err) {
          /* ── WHY IT FAILED DECIDES WHETHER IT IS TRIED AGAIN ─────────────────────────────
           *
           * A refused sign-in stops the automatic re-dial for good; anything else widens the
           * wait. Without this the log line below was literally true — "the next poll tries
           * again" — and that was the defect, not the remedy. */
          /* A RE-DIAL THAT MADE NO PROGRESS IS THE OUTAGE, from the first death's instant. A read
             bound's death armed nothing at the event (see `noteConnectionDead`), so this is where
             its clock starts; any other death already armed it and keeps its first instant. */
          box.outageSince ??= box.connectionDeadSince;
          /* THE NEW CONNECTION SERVED MAIL AND THEN DROPPED: a new death, not a failed dial. It
             waits the first step and the ladder does not climb; a re-dial that drops before its
             first served cycle still climbs below. */
          if (proof?.served === true && isConnectionFailure(err)) {
            if (box.connectionDeadSince === null) {
              box.connectionDeadSince = scope.now();
              box.connectionDeadBy = "bound";
              box.deadGeneration = box.generation;
              box.deadByBreach = false;
            }
            box.outageSince ??= box.connectionDeadSince;
            box.redialWait.arm(box.jittered(scope.reconnect.ladderMs[0]!));
            box.floorPoll.arm(box.redialWait.left());
            box.schedule();
            scope.log("mailbox_redial_after_progress", {
              mailboxId: mb.id,
              attempt: box.redialAttempts,
              retryInMs: box.redialWait.left(),
              reason: "the re-opened connection served mail and then dropped; that is progress, so " +
                "the next re-dial waits the first step and the ladder does not climb",
            });
            return;
          }
          if (err instanceof PlaintextDialRefused) box.plaintextRefusedNow = true;
          box.wentQuiet = dialWentQuiet(err);
          if (certificateRefused(err)) {
            /* No password was sent: the platform refused the handshake before LOGIN. Force or
               not, the press floor rations the next ask; the automatic ladder stops here. */
            box.certificateRefusedNow = true;
            box.forcedWait.arm(scope.reconnect.ladderMs[0]!);
            scope.log("mailbox_certificate_check_failed", {
              err, mailboxId: mb.id,
              reason: "this device would not accept the mail server's certificate, so nothing " +
                "was sent and the automatic re-dial stops; a person's retry or the next " +
                "foreground asks again",
            });
          } else if (credentialsRefused(err)) {
            box.signInRefused = true;
            scope.log("mailbox_sign_in_failed", {
              err, mailboxId: mb.id,
              reason: "the mail server answered and rejected the sign-in, so this install stops " +
                "dialling until the password or token changes. Retrying on the poll would be " +
                "four attempts a minute at a server that has already said no, which providers " +
                "throttle and some answer by locking the account",
            });
          } else if (force) {
            /* Only a FORCED attempt arms the press's floor. Arming it on any failed dial reads
               harmless and is not: during an outage the poll fails on its own cadence, so the
               floor would re-arm every 15 s–5 min and a press be refused almost whenever made.
               UNJITTERED and fixed at the base step, unlike the arm below: it moves with the
               profile so a press rationed at the desktop's 15 s on a phone whose ladder runs at
               5 s does not make the heal slower. Jitter stops mailboxes knocking in unison after
               an outage, a property of the automatic cadence; a person pressing is not a herd,
               and a floor that moved would make "press again in fifteen seconds" unstatable. */
            box.forcedWait.arm(scope.reconnect.ladderMs[0]!);
          } else {
            /* AND ONLY THE POLL CLIMBS THE LADDER — a press is one dial, not evidence about the
               server's schedule; see the contract above. A failed forced attempt used to run
               these two lines as well, which widened the AUTOMATIC wait and restarted it from
               the press: the app's own next attempt then came later than it would have if
               nobody had pressed, so the one control the product offers for a slow heal made
               the heal slower, and six presses walked the wait to the five-minute cap. */
            box.climbTheLadder();
          }
          scope.log("mailbox_reconnect_failed", {
            err, mailboxId: mb.id,
            attempt: box.redialAttempts,
            /* WHEN THE NEXT AUTOMATIC ATTEMPT IS PERMITTED, so a reader can tell a ladder that is
               climbing from one that has stopped. `null` on a refused sign-in — nothing is
               waiting, because nothing will dial until a person acts — and `0` where the next
               poll may dial at once, which is what a failed PRESS leaves (the press does not
               climb the automatic ladder). Read off `redialWait` AFTER the arms above, never
               from the step this call site could compute: the one that ran is the fact. */
            retryInMs: box.signInRefused ? null : box.redialWait.left(),
            totalMs: deadSince ? Date.now() - deadSince.getTime() : 0,
            reason: "the connection could not be re-opened; this install organizes nothing and " +
              "serves the mirror it already has, and the next poll tries again. The clock the " +
              "settings row reports is unchanged — it measures the outage, not the attempts",
          });
        } finally {
          if (box.reconnectProof === proof) box.reconnectProof = null;
          box.redialling = false;
          settle();
        }
      };
      box.dialAndGate = dialAndGate;
      box.redialIfDead = redialIfDead;
}
