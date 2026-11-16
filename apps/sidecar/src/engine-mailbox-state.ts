import { closeStoodDownAppointments, type MailboxDisabledReason, type Tx } from "@trafficflow/db";
import { sweepScheduledSendFiles } from "@trafficflow/services/mail";
import { withMinted } from "@trafficflow/core/adapters/organizer-lease";
import { arrivalBackfill, type ArrivalBackfill } from "./arrival-backfill.js";
import type { LocalRosterRow } from "./identity.js";
import type { SidecarConfig } from "./engine-types.js";
import { WallWait } from "./engine-reconnect.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";

/**
 * The desktop's engine, one section: one mailbox's state: its timers, its serial queue, the claim's and the
 * organizer's standing.
 */
export function stateSection(scope: EngineScope, box: MailboxScope, config: SidecarConfig, mb: LocalRosterRow): void {
      box.stopped = false;
      box.timer = null;
      /**
       * ══ THE IDLE LADDER — WHAT THE NEXT POLL IS ARMED AT ══
       *
       * `pollIntervalMs` while anything is happening; doubled towards {@link IDLE_POLL_CEILING_MS}
       * by each drain that produced nothing, and only while {@link restMayBeTaken}. Reset to base
       * by every event that can change the answer: an INBOX arrival, a press, a resume, a drain
       * that did something, a drain that failed.
       */
      box.idlePollMs = scope.pollIntervalMs;
      /**
       * May this mailbox rest at all — its INBOX watch is armed AND the server advertises IDLE, so
       * an arrival RINGS rather than waits for the next poll. False is the pre-0.19.1 behaviour
       * exactly: the ladder never leaves the base interval. Measured, never assumed.
       */
      box.restMayBeTaken = false;
      /** The INBOX watch's detach, per DIAL — a re-dial builds a new adapter and re-arms. */
      box.unwatch = null;
      /** A kick is armed and has not fired: collapses a burst of arrivals into ONE drain, and
       *  keeps an in-flight drain's own re-arm from cancelling the kick (see {@link schedule}). */
      box.wakePending = false;
      /** A kick FIRED and its drain is waiting to start: every ring until then is that drain. A
       *  drain that starts sees everything pressed before it, so the flag clears at its start. */
      box.ringQueued = false;
      /** A `\Seen` push is queued and has not started: it reads every press committed before it. */
      box.seenPushQueued = false;
      /** WHEN THE ARMED TIMER IS DUE, so a reset can tell "sooner" from "later" rather than
       *  re-arming blind: re-arming a timer that has already waited 100 s of its 120 pushes the
       *  drain FURTHER away, which is the opposite of what every caller of it wants. */
      box.timerDueAt = 0;
      /** A re-dial after a set-aside is due at this instant; the next poll is armed no later. */
      const floorPoll = new WallWait();
      /**
       * THE HEARTBEAT'S OWN TIMER, AND WHY IT IS NOT THE POLL'S.
       *
       * The probe used to run only as the drain's preflight, and the drain re-armed itself from
       * `.finally(schedule)` — so a cycle that HUNG re-armed nothing and the one detector that
       * can see a hung cycle stopped running for as long as the hang lasted. The link then read
       * reachable and organized until the socket deadline fired minutes later, which is the
       * window this timer closes: it is re-armed by the probe's own settlement and by nothing
       * else, so it keeps asking while the cycle is stuck.
       */
      box.heartbeatTimer = null;
      /** The probe in flight, so the preflight and the timer cannot ask twice at once. */
      box.heartbeatInFlight = null;
      /** When the last probe SETTLED — one probe per window, whichever caller arrives first. */
      box.heartbeatSettledAtMs = null;
      /** One serial queue: a poll tick must never start a cycle while one is running, and `stop()`
       *  must be able to wait for whatever is in flight before closing IMAP and the database. */
      box.tail = Promise.resolve();
      /** How much this queue still owes — what {@link LocalMailboxRuntime.quiesce} reports on. A
       *  count and not a boolean because the queue is a chain: a caller that has joined it but not
       *  started is as much "in flight" to a stop as the body currently running. */
      box.queued = 0;
      const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
        box.queued += 1;
        const run = box.tail.then(fn, fn).finally(() => { box.queued -= 1; });
        box.tail = run.catch(() => undefined);
        return run;
      };
      /**
       * WHEN THIS MAILBOX STARTED STOPPING — one instant for the whole stop, however many methods
       * it takes. A removal quiesces and then detaches; giving each its own `detachWaitMs` would
       * be a stop that can take twice as long as the number `detach()` promises, which is the
       * argument that method already makes about its own three waits.
       */
      box.stopStartedAt = null;
      /** Set only where {@link LocalMailboxRuntime.quiesce} is what stopped this runtime. */
      box.heldForRemoval = false;
      const stopLeft = (): number => {
        box.stopStartedAt ??= scope.monotonic();
        return box.stopStartedAt + scope.detachWaitMs - scope.monotonic();
      };

      // The organizer lease — the LOCAL half. A local install cannot query the hosted database
      // and Cloud cannot query this PGlite file, so the mailbox is the only medium the two
      // share and the claim lives in it. The format, priority table and IO are
      // `packages/core`'s; the composition is `@ohmail/organizer/lease`'s. This file supplies
      // the two things Cloud cannot: WHO this install is, and what standing down means on a
      // laptop. The install id is the local `accounts` row: an install resuming its own role is
      // not a takeover, and that distinction IS an install-id match — the id survives a crash,
      // a reboot and a long sleep, and differs between installs (a hostname would collide
      // across two `MacBook-Pro`s; a per-launch value would make every restart a takeover). It
      // is written into a message in the user's OWN mailbox, the only place it goes.
      /** In memory only — the clone defence, and forgetting it on restart is what makes own-role
       *  resumption work. See `LeaseSelf` in the engine. */
      box.leaseNonce = null;
      /**
       * EVERY NONCE THIS RUNTIME MINTED FOR A CLAIM IN THIS MAILBOX'S FOLDER — beside {@link
       * leaseNonce}, in memory for the same reason. A renewal that commits and loses its response
       * leaves the folder carrying a claim this install wrote and was never told about; with only
       * the acknowledged nonce remembered, the next gate read it as a restored clone and stood the
       * RUNNING install down over its own write. Grown before each append (`withMinted`, a new array
       * each time), never cleared by an answer.
       */
      box.leaseMinted = [];
      const noteMinted = (n: string): void => { box.leaseMinted = withMinted(box.leaseMinted, n); };
      /* THE CORRECTION COUNT THIS MAILBOX HAS ALREADY ACTED ON. Seeded with the CURRENT count
         rather than 0: a runtime attaching now has no record of its own to re-admit — its first
         gate runs with `lastNonce` null, which is the launch arm — so a difference here would be
         an admission nobody had a correction for. */
      box.seenClockCorrections = scope.clockCorrections();
      /**
       * WHAT THIS INSTALL'S WRITES RIDE ON. Written by every gate run and asked at every
       * destructive write inside the cycle, so a takeover landing mid-drain stops the remaining
       * moves instead of being noticed at the next gate.
       */
      box.leasePermit = { noLease: "not_supplied" };
      /**
       * When this process last renewed its claim — the fact the release's lapse bound is
       * computed from, in memory deliberately. The claim's heartbeat is the instant handed to
       * `readMailboxLease`, so this is the newest heartbeat any reader of `ohmail/_meta` can see
       * from this install; once it is `staleAfter` old, every other install already reads the
       * claim as stale — which makes the lapse an END of a release the server would not confirm,
       * not a guess. On restart the bound falls back to `release_requested_at`, later than any
       * renewal this install can have written after it; only a restart inside the single racing
       * pass loses a newer renewal, and the cost is a flip early by one pass's duration.
       */
      box.lastLeaseRenewalAt = null;
      /** The server's stamp on the claim the last gate wrote; null when it gave none or did not organize. */
      box.claimServerAt = null;
      /** The arrival times this store lost, asked a page per drain (the phone only), in the drain's upkeep. */
      const arrivals: ArrivalBackfill | null = config.arrivalBackfill === undefined ? null : arrivalBackfill({
        db: scope.db as unknown as Tx, accountId: scope.world.accountId, mailboxId: mb.id, floor: config.arrivalBackfill.floor, log: scope.log,
      });
      /**
       * THE LAST DRAIN ENDED ON A DECLINED WRITE — the lease was asked at a command and did not
       * admit it. Reset by every drain pass; while set, the pass writes nothing more to the mailbox
       * (no request acknowledgements, no profile publish) and the next pass's gate decides.
       */
      box.drainDeclined = false;
      /**
       * A stand-down recorded on the row outlives the process — what makes a lapsed Cloud
       * subscription leave the desktop stood down rather than auto-resuming. The lease alone
       * cannot: once Cloud releases its claim, `ohmail/_meta` is empty, and an empty folder
       * correctly reads as "nobody has ever organized this mailbox" — the arm that organizes.
       * Relaunching the app would silently make this machine the thing that moves somebody's
       * mail: a forgotten office install, woken by a billing event, filing against a rules store
       * frozen at its stand-down. So a stood-down row means this install organizes nothing and
       * the gate is not consulted; only clearing the row does — "Organize from this Mac…".
       */
      /**
       * A request from Settings overrides the row's memory, and changes nothing else. `requestOrganizerTakeover`
       * writes ONLY the stamp and leaves the row `disabled` with its reason; the stamp stops the gate
       * short-circuiting, so the lease is consulted — the one thing that can decide. The row is NOT cleared here:
       * `main.ts` calls `start()` asynchronously and `start()` returns before the gate when no password is stored, so
       * a row cleared at assembly is a `connected` mailbox served to requests before any lease read —
       * `ScheduleService` and `SendService` refuse on `status = 'disabled'` and nothing else, so that window accepts
       * sends for a mailbox another organizer may hold. The clear lives in `mayOrganize`'s ORGANIZE arm, after
       * `readMailboxLease` says yes; a refusal rewrites the row, voids the stamp, and names the install that kept it.
       */
      /* This mailbox's own memory, never the seed's. These five were read off `world` — the
       * SEED's row — the same statement with one mailbox and three silent faults with several:
       * the seed stood down and #2 did not → #2 comes up believing it was demoted and never
       * organizes the mailbox it holds; #2 stood down and the seed did not → #2 comes up with
       * no memory of it and re-claims the mailbox it was demoted from on its next lease read —
       * the auto-resume this memory exists to prevent, the one that moves somebody's mail; a
       * takeover press on ANY mailbox authorized EVERY runtime. `loadLocalRoster` already reads
       * both per row, and `identity.ts` states why; the values were computed and dropped. */
      const takeoverRequested = mb.takeoverAuthorizedAt !== null;
      /**
       * This install has handed the mailbox back and has not been asked to resume. In memory only,
       * set by nothing but {@link LocalMailboxRuntime.handBack}. Without it the hand-back was a
       * release the very next poll undid: the timer still armed, the row still organizer, the gate
       * claimed again — an iPhone suspended a second later held a live claim while running nothing,
       * the one state the hand-back exists to prevent. `handBack` arms it synchronously, before
       * its queue: the gate, the poll, the two signals and each drain's cycle edge all read it.
       * Not `priorStandDown` (another install holds it): this is "nobody runs here", and
       * `resume()` clears it.
       */
      box.handedBack = false;
      /**
       * The stand-down this process remembers — a `let` because the process now outlives the stand-down that
       * sets it. As a `const` read once from the row it was right while a demoted install stopped; mail 0083
       * made the loser a READER — connected, poll timer running — turning a snapshot into a hole: the gate
       * stands down mid-life, the poll fires a minute later, `priorStandDown` is still the assembly-time
       * null, the foreign claim is gone (the other organizer released cleanly) and `decideLease`'s "nobody
       * has ever organized" arm ORGANIZES — the auto-resume this mechanism exists to prevent, with no human
       * action. The gate's two arms maintain it: standing down writes the memory, the press-gated promotion
       * clears it; the value is the row's own, so relaunch and poll agree.
       */
      box.priorStandDown = takeoverRequested ? null : mb.standDownReason;
      /**
       * WHAT THE WINDOW REPORTS, and it is the ROW's answer rather than the gate's optimism: a
       * stood-down install with a request outstanding is still stood down until the lease says
       * otherwise, so `organizerState()` keeps saying so and the pane keeps showing why. Reading
       * `priorStandDown` here instead would announce "organizing" for a mailbox this process has
       * not claimed and may not get.
       */
      box.organizer = mb.standDownReason
        ? { organizing: false, reason: mb.standDownReason as MailboxDisabledReason, heldBy: null,
          unreadableSince: null, unreadableReason: null, releaseRequestedAt: null, claimed: false,
          releaseRefusal: null, holderState: null }
        /* THE STOP IS NOT KNOWN AT ATTACH — it is the ROW's, and the first pass's own read is what
           puts it here. `null` is "nothing has said", which is what an unasked question answers.
           AND NEITHER IS THE ORGANIZING. `claimed` is the ROW's INSTRUCTION and stands; `organizing`
           is a PASS's DECLARATION and no pass has made one, so this is `starting`, which the record
           already names. As `true` it was a declaration nobody made: the mask below can only
           WITHHOLD what a pass declared, and a launch whose dial is refused records the death, arms
           the poll timer and rethrows without ever reaching the gate — every term of the mask then
           read true over a mailbox this install had never asked the lease about. Only the gate
           turns this on. */
        : { organizing: false, reason: null, heldBy: null, unreadableSince: null, unreadableReason: null,
          releaseRequestedAt: null, claimed: true, releaseRefusal: null, holderState: null };
      /**
       * The exit from a stand-down — a human asked for this machine, once. Written by the
       * "organize from this machine" command (`organize-here.ts`), which also clears the row's
       * stand-down. Both halves are needed: clearing the row alone gets as far as the lease, and
       * the lease then refuses a mailbox whose previous organizer left a claim behind without
       * releasing — the crashed-machine case, precisely when somebody sits down at another
       * machine and asks for it. This stamp is the fact that makes that case different. Spent
       * the moment it succeeds: it authorizes one becoming, never a standing right to seize this
       * mailbox back from wherever it may go next.
       */
      box.takeoverAuthorized = mb.takeoverAuthorizedAt !== null;
      /**
       * The exact stamp this pass read, so the stand-down can clear THAT ONE and not whatever is
       * on the row by the time it writes. The gate reads the stamp, then the lease — a network
       * round trip that can take seconds. A press landing inside that window writes a stamp this
       * pass never offered to the lease, and an unconditional `takeoverAuthorizedAt: null` would
       * erase it: the route answered `authorized` and the request is gone with nothing saying so
       * — a press consumed by a pass that could not act on it. Comparing rather than
       * serializing, because the route must stay answerable while a slow lease read is in
       * flight; a button press must not block behind an IMAP timeout.
       */
      box.observedTakeoverAt = mb.takeoverAuthorizedAt;
      /**
       * WHAT THAT PRESS ASKED FOR, moving with the stamp beside it and never read on its own. The
       * pair is one fact: the in-flight-press comparison below clears exactly the stamp this pass
       * READ, so an intent fetched by a second statement could describe a different press.
       */
      box.observedIntent = mb.takeoverIntent;

      /**
       * Has anybody asked this install to organize this mailbox — `organize_consented_at`, as the row
       * holds it, re-read by the gate on every pass. TRUE at assembly, chosen rather than convenient:
       * `world` does not carry the column, so the first value is a guess until the gate's own read
       * replaces it one statement into `mayOrganize` — which runs before anything organizes, so the
       * guess is never acted on. What it must not be is wrong in the hurting direction: an install
       * organizing for months, briefly reading un-consented, would demote itself and stop moving mail
       * for a live customer; reading as consented and being corrected costs nothing. The same asymmetry
       * `OnboardingMailbox.organizerRole` documents, resolved the other way for the opposite reason.
       */
      box.consented = true;

      /**
       * Has THIS process created the `ohmail/*` tree in the mailbox yet?
       *
       * One IMAP round trip is what it saves; correctness is what it exists for. `ensureFolders` is
       * the write that makes an organizer's destinations exist, and it has two callers now — the
       * launch, and the pass on which a promotion takes effect — so the flag is the thing that keeps
       * them from being two answers to "have the folders been made". False at construction and never
       * reset: a demotion does not remove the folders, and an install that is promoted again has
       * nothing to re-create.
       */
      box.foldersEnsured = false;
      /**
       * The stamp the last promotion spent and where its sweep stands. Each organizing drain runs the
       * sweep until `next` is null; any other verdict or a throw clears it. Memory only.
       */
      box.agreeSweep = null;

      /**
       * CLOSE THE SEND-LATER APPOINTMENTS A STAND-DOWN ORPHANS — the local half of
       * `closeStoodDownAppointments`, which holds the whole argument for why they are FAILED rather
       * than handed over.
       *
       * Never throws: it is called from the stand-down path and from the launch below, and neither
       * may be made contingent on it. A failure is logged and retried — the next launch of a
       * still-stood-down install runs the catch-up again, and the row it would close is still
       * exactly as it was.
       */
      const standDownAppointments = async (
        reason: MailboxDisabledReason,
        /**
         * The RELEASE's sentence, when this close is a release rather than a stand-down (mail
         * 0088). Omitted, `reason` chooses — the stand-down arm and the launch catch-up. See
         * `RELEASED_ORGANIZER_SEND_SENTENCE` for why a release cannot quote a stand-down's.
         */
        sentence?: string,
      ): Promise<void> => {
        try {
          const r = await closeStoodDownAppointments(scope.db as unknown as Tx, {
            accountId: scope.world.accountId, mailboxId: mb.id, reason, now: scope.now(),
            ...(sentence !== undefined ? { sentence } : {}),
          });
          // Only when something closed: an install with no appointments — the overwhelming case —
          // stays silent on every stand-down and every launch, the rule every pass here follows.
          if (r.closed > 0) scope.log("scheduled_sends_stood_down", { closed: r.closed, disabledReason: reason });
          // The closed appointments' kept files go with them (mail 0179).
          if (r.closed > 0) await sweepScheduledSendFiles(scope.unbound, { mailboxIds: [mb.id] }).catch(() => 0);
        } catch (err) {
          scope.log("scheduled_sends_stand_down_failed", {
            err,
            reason: "a scheduled send this install can no longer make was not closed with its " +
              "sentence; the row still says it will send, and the next launch tries again",
          });
        }
      };
      box.floorPoll = floorPoll;
      box.serialize = serialize;
      box.stopLeft = stopLeft;
      box.noteMinted = noteMinted;
      box.arrivals = arrivals;
      box.standDownAppointments = standDownAppointments;
}
