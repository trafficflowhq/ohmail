import { ImapAdapter, loopbackHarnessReason, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { PlaintextDialRefused } from "@trafficflow/api/local";
// The ORGANIZER LEASE, from the same package and for the same reason: two readings of one decision
// table is how a LOCAL install and the CLOUD service come to disagree about who organizes a
// mailbox, and disagreement here IS the dual-organizer bug.
// `releaseMailboxClaim` for the same one-implementation reason: expunging THIS install's claim
// is the act Cloud performs when it stops being entitled to organize a mailbox, and a second
// spelling of "which of these messages are mine" is how two organizers come to disagree about
// whose claim is whose. The worker's own call site (`releaseOrganizerClaim`) states the cost of
// not doing it: a fresh claim nobody holds stands another install down for the whole staleness
// window, at exactly the moment somebody has chosen to leave.
import {
  DEFAULT_STALE_AFTER_MS,
} from "@ohmail/organizer/lease";
import type { LeasePeekAnswer } from "@trafficflow/core/adapters/organizer-lease";
import type { ArrivalReader } from "./arrival-backfill.js";
import type { LocalRosterRow } from "./identity.js";
import type { DetachBounds, DialAnswer, LocalMailboxRuntime } from "./roster.js";
import type { SidecarConfig } from "./engine-types.js";
import { releaseOwnClaim } from "./engine-local-services.js";
import { ONE_SHOT_DIAL, SignedOutError, settledWithin } from "./engine-reconnect.js";
import { certificateRefused, dialWentQuiet, credentialsRefused } from "./engine-classifiers.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";

/**
 * The desktop's engine, one section: one mailbox's runtime: the record the roster keeps, with its start, its detach
 * and its stop.
 */
export function runtimeSection(
  scope: EngineScope, box: MailboxScope, config: SidecarConfig, mb: LocalRosterRow, isSeed: boolean,
): void {
      /**
       * START THIS MAILBOX AND ANSWER AT THE DIAL — for a caller a person is waiting on. `start()`
       * settles after the first drain, which is minutes on a large mailbox; a sign-in or TLS
       * refusal arrives at the login, so that is when `dial` answers. The drain carries on behind
       * it, and a start that dials nothing (no usable password) answers `not-dialled`. `started` is
       * the start itself, for a caller that reports it as `start()` does.
       */
      const startAnswering = (): { dial: Promise<DialAnswer>; started: Promise<void> } => {
        let answered = false;
        let resolveDial: (a: DialAnswer) => void = () => {};
        const dial = new Promise<DialAnswer>((resolve) => { resolveDial = resolve; });
        const answer = (a: DialAnswer): void => {
          if (answered) return;
          answered = true;
          box.onDialled = null;
          resolveDial(a);
        };
        box.onDialled = () => answer({ outcome: "dialled" });
        /* The skip is over: `start()` sets it again if this launch has no password either. */
        box.launchSkipped = false;
        const started = rt.start();
        started.then(() => answer({ outcome: "not-dialled" }), (err: unknown) => answer({ outcome: "failed", err }));
        return { dial, started };
      };

      const launch = (): Promise<DialAnswer> => {
        const { dial, started } = startAnswering();
        started.catch((err: unknown) => { scope.log("mailbox_start_failed", { err }); });
        return dial;
      };

      /**
       * THE STOP ON TWO INSTANTS — `detach()`'s body, split so a quit can close the store between
       * its halves. The pass (the queue, and any re-dial) gets until `passBy`; past it the socket is
       * destroyed at once, which ends the server call it was parked in. A mailbox whose pass let go
       * then leaves its settings (the install's own quit), gives its claim back and logs out, until
       * `goodbyeBy`; past that the socket is destroyed too. The settings flush reads the store, so it
       * is a writer: `passSettled` waits for it until `passBy` as well, and a flush still running then
       * meets the closed store and is said as not saved. `quit` marks a quit plan's instants rather
       * than one drain interval's.
       */
      const detachBy = (
        leaving: "quit" | "restart", by: DetachBounds, quit: boolean, opts: { leaveSettings?: boolean } = {},
      ): { passSettled: Promise<void>; done: Promise<boolean> } => {
        box.stopped = true;
        if (box.timer) clearTimeout(box.timer);
        if (box.heartbeatTimer) clearTimeout(box.heartbeatTimer);
        /* `startedAt` is read back from the stop's one instant, so the forced line measures the
           whole stop rather than this method's slice. */
        box.stopStartedAt ??= scope.monotonic();
        const startedAt = box.stopStartedAt;
        const leftUntil = (at: number): number => at - scope.monotonic();
        const force = (phase: "pass" | "goodbye", at: number): void => {
          /* The same teardown the re-dial uses on a connection found dead, and for the same
             reason. `adapter` is re-read here, so a re-dial that installed a fresh one is the one
             that goes: this runtime is stopping, and the newest connection is the one with no
             owner. */
          const held = box.adapter;
          if (held.forceClose !== undefined) {
            try { held.forceClose(); } catch { /* the socket is going away regardless */ }
          } else {
            /* An injected double with no `forceClose`. NOT awaited — a teardown this method waits
               on is the latch it is escaping. */
            try { void Promise.resolve(held.close()).catch(() => undefined); }
            catch { /* threw synchronously; it is going away either way */ }
          }
          if (quit) {
            scope.log("mailbox_detach_forced", {
              mailboxId: mb.id,
              phase,
              boundMs: Math.round(at - startedAt),
              totalMs: Math.round(scope.monotonic() - startedAt),
              reason: "this install is quitting and this mailbox did not finish its " + phase
                + " inside the quit's bound, so the connection was destroyed so that the local "
                + "store closes cleanly; the next launch picks the mailbox up where it was",
            });
            return;
          }
          scope.log("mailbox_detach_forced", {
            mailboxId: mb.id,
            pollIntervalMs: scope.detachWaitMs,
            totalMs: Math.round(scope.monotonic() - startedAt),
            reason: "this mailbox did not let go within one drain interval — the cycle, the " +
              "re-dial or the logout was waiting on a link that answers nothing, which is what " +
              "a half-open link produces — so the connection was destroyed and the stop " +
              "completed. Destroying it is also what ends the hung command, so nothing is left " +
              "to log out and the mailbox's timers are already down",
          });
        };
        const passSettled = (async (): Promise<boolean> => {
          /* THE QUEUE, which a drain parked inside a serialized body holds. */
          let settled = await settledWithin(box.tail, leftUntil(by.passBy));
          /* AND THE RE-DIAL, WHICH IS NOT IN THE QUEUE — see {@link redialInFlight}. Without this
             a re-dial suspended in `connect()` resumes AFTER the teardown has closed the adapter
             and dropped the runtime, and then installs a fresh authenticated connection for a
             mailbox that no longer exists: an organizer claim renewed after the removal route
             released it, folders created in somebody's mailbox on the way out, and a login with
             no handle anywhere that can close it. `stopped` is already true here, so the re-dial's
             own re-checks turn this wait into an early exit rather than a full second dial.
             It SHARES the bound rather than getting its own: two bounds in sequence would be a
             stop that can take twice as long as the number this method promises. */
          if (settled) settled = await settledWithin(box.redialInFlight, leftUntil(by.passBy));
          if (!settled) force("pass", by.passBy);
          return settled;
        })();
        /* `claimed` AND NOT `organizing` — the field that means "a claim of ours may be in the
           folder". The gate takes the claim a full round trip before it declares `organizing`
           (see the CLAIM IS OURS FROM HERE block), so a stop landing inside that window read
           the ATTACH DEFAULT rather than anything this pass knew, and reached the right answer
           by accident. No reachable state has `organizing` true with `claimed` false, so this
           releases in exactly the cases it released in before, and in the window as well.
           NOT on a runtime that never dialled: there is no login to release through, and the
           attempt was a TypeError logged as a failed release. A claim from before ages out.
           AND NOT ON A RESTART THE SHELL MARKED: the relaunch continues this claim under the same
           install id (lease rule 3); a restart that never comes back leaves it to age out. */
        const keepForRestart = leaving === "restart";
        const giving = passSettled.then((settled) => settled && box.organizer.claimed && !box.launchSkipped && !keepForRestart);
        /* THE APP'S OWN QUIT LEAVES ITS SETTINGS FIRST (RULING-026 lane A, as amended):
           the last write, with the instant this install let go, while the claim is still ours and
           inside this same bound. A refused write is said once and the claim still goes back; one
           that hangs runs out the bound the release has, and the claim then ages out as before.
           Only `stop()` asks: a removal (its route released the claim and wiped the store before
           this) and a re-point (attached again at once) never do. */
        const settingsFirst = async (): Promise<void> => {
          if (opts.leaveSettings !== true || !box.organizer.organizing) return;
          let written: Awaited<ReturnType<typeof box.profileSync.flushBeforeLeaving>> = "not_saved";
          try {
            written = await box.profileSync.flushBeforeLeaving(box.leasePermit, box.adapter, await box.lettingGo());
          } catch { /* never thrown by its contract; said below as not saved if it is */ }
          box.settingsNotLeft(written, "quit");
        };
        const settings = giving.then((give) => (give ? settingsFirst() : undefined));
        const writesSettled = (async (): Promise<void> => {
          if (await passSettled) await settledWithin(settings, leftUntil(by.passBy));
        })();
        const releasedOnStop = (released: number | "sibling" | null): void => {
          box.leaseNonce = null;
          box.organizer = { ...box.organizer, organizing: false };
          if (typeof released === "number" && released > 0) {
            scope.log("organizer_claim_released_on_stop", {
              mailboxId: mb.id,
              claims: released,
              reason: "this install stopped organizing this mailbox because it is shutting "
                + "down, so the claim is given back rather than left to age out; the row is "
                + "untouched and the next launch claims the mailbox again unless another "
                + "install has taken it",
            });
          }
        };
        /* A QUIT THAT CUT THE PASS STILL GIVES THE CLAIM BACK, on a one-shot dial of its own (the
           cut socket is gone) until `goodbyeBy`. Addressed by (install, nonce), so it cannot remove
           a newer claim. The settings flush reads the store, closed by now, so it is skipped. */
        const releaseAfterCut = async (until: number): Promise<void> => {
          const fresh = config.adapterFactory
            ? config.adapterFactory(box.imapConfig, ONE_SHOT_DIAL)
            : new ImapAdapter(box.imapConfig, ONE_SHOT_DIAL);
          const releasing = (async () => {
            if (box.signedOutSinceDial()) return;
            await box.pinPlaintextDial(box.imapConfig);
            await fresh.connect();
            releasedOnStop(await releaseOwnClaim(
              fresh, scope.installId, mb.id, { current: box.leaseNonce, minted: box.leaseMinted }, scope.log,
              "this install is quitting, its pass was cut and its claim could not be removed; it "
                + "ages out of ohmail/_meta on its own and another install takes the mailbox then",
            ));
            await fresh.close();
          })().catch((err: unknown) => {
            scope.log("organizer_claim_release_failed", {
              err, mailboxId: mb.id,
              reason: "this install is quitting and could not open a connection to remove its "
                + "claim; it ages out of ohmail/_meta on its own and another install takes the "
                + "mailbox then",
            });
          });
          if (await settledWithin(releasing, leftUntil(until))) return;
          try { fresh.forceClose?.(); } catch { /* going away regardless */ }
        };
        const done = passSettled.then(async (settled) => {
          if (!settled) {
            if (quit && !keepForRestart && box.organizer.claimed && !box.launchSkipped) await releaseAfterCut(by.goodbyeBy);
            return true;
          }
          /* AND THE CLAIM GOES BACK, then the LOGOUT — ONE wait, in that order. The claim first
             because the release needs the login; left standing it obstructs every other install
             for `DEFAULT_STALE_AFTER_MS` while the machine that wrote it is gone. Only where this
             install believes it organizes — a reader's release would be an IMAP read that can only
             fail. The logout's rejection still reaches the log: a server answering LOGOUT with an
             error is not one answering nothing. ONE `settledWithin`, started in a MICROTASK, both
             for the bound: a fourth hop re-derives its deadline, and `setTimeout` schedules against
             the loop's clock, which a synchronous prologue does not refresh — measured as a 299
             against a 300 ms bound. */
          const politely = giving.then((give) => (give
            ? settings.then(() => releaseOwnClaim(
              box.adapter, scope.installId, mb.id, { current: box.leaseNonce, minted: box.leaseMinted }, scope.log,
              "this install is stopping and its claim could not be removed; it ages out of "
                + "ohmail/_meta on its own and another install takes the mailbox then",
            )).then(releasedOnStop)
            : keepForRestart && box.organizer.claimed && !box.launchSkipped
              ? Promise.resolve().then(() => {
                scope.log("organizer_claim_kept_for_restart", {
                  mailboxId: mb.id,
                  staleAfterMs: config.leaseStaleAfterMs ?? DEFAULT_STALE_AFTER_MS,
                  reason: "the shell is restarting this app, so the claim stays in ohmail/_meta for "
                    + "the relaunch to continue; a restart that does not come back leaves it to age out",
                });
              })
              : Promise.resolve()))
            .then(() => Promise.resolve(box.adapter.close()))
            .catch((err: unknown) => { scope.log("adapter_close_failed", { err }); });
          if (await settledWithin(politely, leftUntil(by.goodbyeBy))) return false;
          force("goodbye", by.goodbyeBy);
          return true;
        });
        return { passSettled: writesSettled, done };
      };

      const rt: LocalMailboxRuntime = {
        mailboxId: mb.id,
        address: mb.address,
        get imap() { return box.mbImap; },
        get adapter() { return box.adapter; },
        get syncDeps() { return box.syncDeps; },
        get timer() { return box.timer; },
        set timer(v) { box.timer = v; },
        get tail() { return box.tail; },
        set tail(v) { box.tail = v; },
        get stopped() { return box.stopped; },
        set stopped(v) { box.stopped = v; },
        get priorStandDown() { return box.priorStandDown; },
        set priorStandDown(v) { box.priorStandDown = v; },
        /**
         * ORGANIZING IS THE MECHANISM, NOT THE INTENT — three facts meet here: a claim this install
         * holds, a poll timer armed (on this tier also the RENEWAL, since the gate runs at the top
         * of every cycle), and neither a hand-back nor a stop standing. A claim taken by a start
         * that has not armed its timer is `starting` — {@link OrganizerState.claimed} true with
         * `organizing` false — and is what a failed resume used to report as organizing. Asymmetric
         * with the setter on purpose: a pass WRITES its intent, a caller READS what exists.
         */
        get organizer() {
          /* A MASK, NEVER A SOURCE. The mechanism can only WITHHOLD what the pass declared — it may
             not grant it: `claimed` is the INSTRUCTION, set at attach from the row, so a launch
             whose lease could not be read has it true with no pass behind it, and deriving from the
             mechanism alone would report that mailbox as organized. Measured by
             `connection-release.e2e.test.ts`'s unreadable-lease-at-launch case. */
          const running = box.organizer.organizing
            && box.organizer.claimed && box.timer !== null && !box.handedBack && !box.stopped;
          return box.organizer.organizing === running ? box.organizer : { ...box.organizer, organizing: running };
        },
        set organizer(v) { box.organizer = v; },
        get takeoverAuthorized() { return box.takeoverAuthorized; },
        set takeoverAuthorized(v) { box.takeoverAuthorized = v; },
        get observedTakeoverAt() { return box.observedTakeoverAt; },
        set observedTakeoverAt(v) { box.observedTakeoverAt = v; },
        get consented() { return box.consented; },
        set consented(v) { box.consented = v; },
        get foldersEnsured() { return box.foldersEnsured; },
        set foldersEnsured(v) { box.foldersEnsured = v; },
        get leaseNonce() { return box.leaseNonce; },
        set leaseNonce(v) { box.leaseNonce = v; },
        /* READ-ONLY on the record: the ring is written by the gate and by the permit, at the
           instant a claim is minted, and a setter would be a second writer of an identity only the
           write path can know. See the field. */
        get leaseMintedNonces() { return box.leaseMinted; },
        get profileSync() { return box.profileSync; },
        get holderLooked() { return box.holderLooked; },
        /* THE CONNECTION'S OWN ANSWER, derived and never stored: the pair of closure fields IS
           the state, and this shapes them for a caller. `reachable` is the negation of "we have
           observed a death that no re-dial has undone" — not a probe, and deliberately not one:
           asking the socket here would put an IMAP round trip on a settings render. */
        get connection() {
          /* `outageSince` AND NOT `connectionDeadSince` — see the field. The socket one clears the
             moment a dial succeeds, which is what stops a re-dial per poll; this one clears only
             when a cycle has actually been served. The row must follow the mailbox, not the
             socket, or a re-dial onto a live server with an unreadable lease reports a mailbox
             that is being organized when nothing is being filed. */
          return {
            /* AND NOTHING IS REACHABLE THAT WAS NEVER DIALLED. `outageSince === null` alone is
               the negation of an observed death, which a runtime that opened no socket at all
               cannot have — so a mailbox with no password answered `true` and Settings said "Up
               to date" over one that had never read a byte. See {@link needsCredential}: it is
               the state's own name, and the surfaces rank it above the outage arm. */
            reachable: box.outageSince === null && !box.needsCredential && !box.launchSkipped,
            /* AND WHETHER ANYTHING HAS DIALLED THIS RUNTIME AT ALL: a password sealed onto a launch
               that was skipped is dialled by the NEXT launch, never here, so until then it is not
               reachable and not an outage either — nothing was tried and nothing failed. */
            dialled: !box.launchSkipped,
            unreachableSince: box.outageSince,
            /* NO PASSWORD ON THIS INSTALL — the state, not a diagnosis of the server. Rides
               beside `unreachableSince` rather than inside it: there is no outage clock to
               name, and an outage sentence would send somebody to look at a working network. */
            needsCredential: box.needsCredential,
            needsCredentialSince: box.needsCredentialSince,
            /* AND WHY, WHEN THE REASON IS THIS INSTALL'S OWN STORE rather than the server. No
               socket was opened at all here, so "can't reach the mail server" would send somebody
               to look at a network that is working. See {@link CredentialBlock}. */
            credentialBlocked: box.credentialBlock,
            /* AND WHETHER THE SETTINGS DOCUMENT CAN BE KEPT AT ALL — read off the profile sync,
               which is the only thing that knows. The drain cannot answer this: it says mail is
               coming down, and a claimed mailbox whose `ohmail/_meta` refuses every read drains
               perfectly while none of the person's rules can be read. See {@link ProfileBlock}. */
            profileBlocked: box.profileSync.profileBlock(),
            /* THE DIAGNOSIS, not just the fact. "Can't reach the mail server" over a server that
               answered and said no is the wrong sentence: it sends somebody to look at their
               network when the answer is their password. */
            signInRefused: box.signInRefused,
            /* A SERVER ON THIS COMPUTER (a gateway such as DavMail): its NO and its silence are its
               own sign-in's, said apart. From the host this runtime dials NOW, which moves. */
            localServer: loopbackHarnessReason(box.imapConfig.host) !== null,
            signInWentQuiet: box.wentQuiet,
            /* THE CERTIFICATE, named apart from an outage: nothing is re-dialling it. */
            certificateRefused: box.certificateRefusedNow,
            /* THE PLAINTEXT SERVER OFF THE PERSON'S NETWORK, named apart from an outage too. */
            plaintextRefused: box.plaintextRefusedNow,
            /* AND WHAT THE FIRST SYNC PRODUCED, read in the same pass for the reason the record's
               own header gives: two reads would be two clocks. */
            firstSync: box.firstSync.state(),
            writeOffsHeldSince: box.deadLetters.writeOffsHeldSince,
            storeFaultSince: box.deadLetters.storeFaultSince,
            /* HOW MANY MESSAGES THIS DEVICE SET ASIDE and has not read since: the ledger's own
               terminal count, hydrated from the store each cycle and lowered where a re-read
               resolves a row. A count only: no address, no subject, no folder. */
            setAside: box.deadLetters.skipped,
          };
        },
        serialize: box.serialize,
        syncUntilQuiet: box.syncUntilQuiet,
        networkReturned: (): boolean => {
          /* Only a connection known dead is waiting on the ladder, and a refused sign-in or
             certificate waits for a person, not for the network. */
          if (box.stopped || box.connectionDeadSince === null || box.signInRefused || box.certificateRefusedNow) {
            return false;
          }
          if (box.networkWait.left() > 0) return false;
          box.networkWait.arm(scope.reconnect.ladderMs[0]!);
          box.redialWait.clear();
          void box.redialIfDead().catch(() => { /* the dial logs its own failure */ });
          return true;
        },
        /* The foreground wake — see `LocalMailboxRuntime.redial`. The SAME function the poll runs,
           handed a second caller rather than reimplemented: a wake that dialled by its own route
           would be a second dial path, and the one thing both must do identically is take the
           lease gate before anything is moved. */
        redial: box.redialIfDead,
        credentialState: async () => (await box.resolveLogin()).state,
        forgetStoredLogin: box.forgetStoredLogin,
        purgeCredential: box.purgeCredential,
        /**
         * THE SEALED PASSWORD WAS REPLACED — see {@link LocalMailboxRuntime.credentialReplaced}.
         *
         * The re-read is what re-points this runtime's dial and its request key together; the
         * clear is what lets a re-dial happen at all, since a refused sign-in suspends it. The
         * dial is AWAITED so the route answers a verdict about the connection; the cycle behind
         * it is not — one cycle, forced, because a person is waiting and a first sync is minutes.
         */
        async credentialReplaced(opts) {
          if (box.stopped) return null;
          const moved = opts?.followRow === true && await box.adoptRowDial();
          await box.rereadCredential();
          /* THE SEED'S CONSENT AND PIN FOLLOW ITS ROW ({@link seedDial}): the press just proved them.
             Only where the dial is the configuration (the desktop): a composition that follows the
             row took the row's consent and pin with its endpoint in `adoptRowDial` above. */
          if (isSeed && opts?.followRow !== true) await box.adoptSeedConsent();
          box.clearSignInRefusal("the stored password was replaced");
          /* THE SAME MAILBOX ON ANOTHER PORT OR TLS MODE: the socket is replaced and the claim is
             not touched — the re-dial destroys the old connection without a release, and the
             gate on the new one renews the claim it finds under this install's own nonce. */
          if (moved && box.connectionDeadSince === null) {
            box.connectionDeadSince = scope.now();
            box.connectionDeadBy = "replaced";
          }
          /* NO LOGIN TO RE-OPEN, SO NO CYCLE. The re-dial acts only on an observed death, and a
             runtime that never dialled has none, so the forced cycle drained over an adapter
             nothing had connected — the TypeError on every first connect. The door's seal is
             followed by an engine the door starts, which is that launch; a "Sign in again" press
             has nothing behind it, so it asks for the launch here. See {@link launchSkipped}. */
          if (box.launchSkipped) {
            if (opts?.launch === true) {
              scope.log("mailbox_launch_on_press", {
                mailboxId: mb.id,
                reason: "this mailbox started without a password and one was just stored from "
                  + "Settings, so it is launched now rather than at the next start",
              });
              return launch();
            }
            scope.log("mailbox_relogin_skipped", {
              mailboxId: mb.id,
              reason: "this mailbox started without a password and has not dialled on this "
                + "launch, so there is no login to re-open; the stored password is dialled by "
                + "the launch that opens this mailbox",
            });
            return null;
          }
          await box.redialIfDead({ force: true });
          void box.syncUntilQuiet(1, { force: true }).catch((err: unknown) => {
            scope.log("mailbox_relogin_cycle_failed", { mailboxId: mb.id, err });
          });
          return null;
        },
        launch,
        startAnswering,
        async start() {
          // ── A PASSWORD THAT IS THERE AND CANNOT BE USED IS AN OUTAGE ──────────────────────
          //
          // One line used to cover three different facts. `absent` is genuinely quiet: nothing is
          // stored and a person is being asked for one. `unreadable` and `foreign-host` are the
          // opposite — this install WAS syncing, the sealed row is intact, and this launch served
          // nothing. Returning in silence left `outageSince` null with no retry armed, so Settings
          // said "Up to date" over a mailbox that had stopped. It is recorded as the outage it is,
          // on the same ladder an unreachable server gets; the credential is not discarded.
          if (box.login.state === "unreadable" || box.login.state === "foreign-host") {
            box.noteLoginUnusable(box.login.state);
            box.schedule();
            return;
          }
          // ── NO PASSWORD, NO CONNECTION — AND THAT IS NOT A FAILED LAUNCH ──────────────────
          //
          // Offline is a property of this mode: the organizer is paused and the viewer is
          // complete, so the bridge keeps serving the mirror and the shell shows a password
          // field. Throwing here instead would make a missing password look like a broken app,
          // and a mailbox whose key was replaced would be unrecoverable rather than one prompt
          // away. Deliberately BEFORE `connect()`: an empty password is a login attempt the
          // server will refuse, and a refused login on some providers counts toward a lockout.
          //
          // IT IS SAID, THOUGH. Returning in silence left `outageSince` null over a runtime that
          // had opened nothing, so the connections route answered `reachable: true` and the row
          // read "Up to date" — measured by signing out with two mailboxes and reconnecting only
          // the primary. Nothing is scheduled with it: with no password there is nothing to
          // retry, and the state is what a person acts on.
          // No second log line: the attach above already wrote `stored_login_absent` once, and a
          // state a surface renders is not news to repeat.
          if (box.login.state !== "ready" || !box.login.pass) {
            box.needsCredential = true;
            box.needsCredentialSince ??= scope.now();
            box.launchSkipped = true;
            return;
          }
          /* …AND NOT AFTER A SIGN-OUT. Same shape and same place as the line above, for the same
             reason: this is not a failed launch, it is an install with no password to use. The
             throwing check in `dialAndGate` is what the re-dial meets; a launch answers quietly
             so a sign-out during boot does not surface as a broken app. */
          if (box.signedOutSinceDial()) {
            /* THE SAME STATE AS THE ARM ABOVE, and it is set for the arm above's reason: this
               runtime opened no socket, so nothing may report it reachable. */
            box.needsCredential = true;
            box.needsCredentialSince ??= scope.now();
            box.launchSkipped = true;
            scope.log("stored_login_absent", {
              mailboxId: mb.id,
              state: "absent",
              reason: "this install signed out while it was starting, so no login was opened on "
                + "the password this launch had already read",
            });
            return;
          }
          /* THE LAUNCH DIAL JOINS THE SAME WAIT `detach()` HONOURS.
           *
           * `detach()` awaited `tail` and the re-dial handle, but not this — so a removal landing
           * during a LAUNCH could close the adapter while `dialAndGate` was still inside it, and
           * the stand-down that arm now performs (releasing the claim the gate just renewed) would
           * be cut off by detach's own close. Re-dial and launch run the identical sequence; they
           * should be waited for identically. */
          let settleStart: () => void = () => {};
          box.redialInFlight = new Promise<void>((resolve) => { settleStart = resolve; });
          let launched: { leaseRead: boolean; drainError?: unknown };
          try {
            launched = await box.dialAndGate();
            box.wentQuiet = false;
          } catch (err) {
            /* A launch that could not dial is an OUTAGE, not a dead mailbox. `connect()` can reject
             * with the adapter emitting nothing (refused TCP, TLS failure, no greeting), so no
             * detector fired and `start()` threw before arming the poll — a mailbox reported
             * reachable for ever with no path to heal, the failure-looks-healthy shape from the one
             * direction nothing watched. So the death is recorded and the timer IS armed; `main.ts`
             * still learns the launch failed (rethrown). `null` for the adapter: `dialAndGate`'s
             * catch has ALREADY closed it (`connection-release.e2e.test.ts`), and a second close
             * here closed the login twice. */
            box.noteConnectionDead(err, box.generation, null);
            box.wentQuiet = dialWentQuiet(err);
            if (certificateRefused(err)) box.certificateRefusedNow = true;
            if (err instanceof PlaintextDialRefused) box.plaintextRefusedNow = true;
            if (credentialsRefused(err)) {
              box.signInRefused = true;
              scope.log("mailbox_sign_in_failed", {
                err, mailboxId: mb.id,
                reason: "the mail server answered this launch and rejected the sign-in; the " +
                  "mirror is served and nothing is dialled again until the password changes",
              });
            }
            box.schedule();
            /* AND THE HEARTBEAT: the re-dial that heals this launch carries the rest of its import. */
            if (box.heartbeatTimer === null) box.armHeartbeat();
            throw err;
          } finally {
            settleStart();
          }
          // ARMED HERE and not inside the sequence above. `schedule()` returns at `stopped`,
          // which is the mailbox-was-removed arm's exit and the one path that must not poll.
          box.schedule();
          /* AND THE HEARTBEAT'S OWN TIMER, on the same rule and for the reason its field states:
             the probe may not depend on a cycle finishing. */
          box.armHeartbeat();
          /* THE FIRST DRAIN FAILED AND THE CONNECTION STANDS: the launch still reports the failure
             (`mailbox_start_failed`), with the poll and the heartbeat armed over the kept login and
             no outage recorded. */
          if (launched.drainError !== undefined) throw launched.drainError;
        },
        /**
         * STOP TAKING WORK AND WAIT OUT THE PASS ALREADY RUNNING — the half of a stop that must
         * happen BEFORE the caller writes anything about this mailbox. The removal route used to
         * run straight past a pass parked in a server call, which then committed its messages into
         * a tombstoned, emptied mailbox: mail left on the machine, its arrival announced after the
         * receipt that said the mailbox was gone. So the row and the mirror are not touched until
         * this returns. The login is left OPEN — the claim release needs it, and `detach()` closes
         * it on the SAME budget, so a removal costs one drain interval and not two.
         */
        async quiesce() {
          const waiting = box.queued > 0;
          /* WHO PUT IT ON HOLD, so `unquiesce` can only take back what this did. A runtime that
             was already stopped — a removal discovered mid-launch, a takeover that found the row
             gone — is NOT revived by a removal that then failed; it is still stopped for its own
             reason. The wait below runs either way: `stopped` can be set mid-pass. */
          box.heldForRemoval = !box.stopped;
          box.stopped = true;
          if (box.timer) clearTimeout(box.timer);
          box.wakePending = false;
          box.ringQueued = false;
          if (box.heartbeatTimer) clearTimeout(box.heartbeatTimer);
          if (waiting) {
            scope.log("local_mailbox_pass_awaited", {
              mailboxId: mb.id,
              pollIntervalMs: scope.detachWaitMs,
              reason: "this mailbox was reading mail when it was stopped; the pass is waited out "
                + "before anything is written about the mailbox, so nothing it is carrying is "
                + "committed after the row has been removed",
            });
          }
          const wedged = !(await settledWithin(box.tail, box.stopLeft()))
            || !(await settledWithin(box.redialInFlight, box.stopLeft()));
          if (wedged) {
            scope.log("local_mailbox_pass_not_awaited", {
              mailboxId: mb.id,
              pollIntervalMs: scope.detachWaitMs,
              reason: "this mailbox did not finish its pass within one drain interval, so the stop "
                + "went ahead without it; the pass's own writes are refused against a removed "
                + "mailbox rather than committed behind it",
            });
          }
        },
        /**
         * TAKE THE MAILBOX BACK OFF HOLD — for the caller that quiesced and then did NOT remove it.
         *
         * `MailboxService.delete` can refuse (it owns the row check) or fail, and the removal
         * route holds the mailbox BEFORE it asks. Without this, a refused removal left a mailbox
         * the person still has with its poll timer cleared and its runtime stopped until the next
         * launch, while Settings went on reporting it reachable — the false-state class, reached
         * through a failure of the very act that is supposed to leave nothing behind.
         */
        noteWorldMoved: box.noteWorldMoved,
        ring: box.onMailboxSignal,
        pushSeen: box.pushSeen,
        /* Only while this connection can ask: an adapter with no date read never fills them. */
        arrivalsWithheld: async () => box.arrivals !== null
          && typeof (box.adapter as Partial<ArrivalReader>).readArrivals === "function" && await box.arrivals.withholds(),
        unquiesce() {
          if (!box.heldForRemoval) return;
          box.heldForRemoval = false;
          box.stopped = false;
          /* AND THE BUDGET GOES BACK TOO. It is a wall-clock instant, so a hold that was taken and
             released an hour ago would leave the next `detach()` with a budget already spent: it
             would wait zero, call itself wedged and destroy a live socket on a mailbox that is
             stopping normally. */
          box.stopStartedAt = null;
          /* The two timers the hold cleared, and nothing else: the login was never closed, the
             claim was never released, and the pass this hold waited out has already ended. */
          box.schedule();
          box.armHeartbeat();
        },
        /**
         * Stop this mailbox, give its claim back, and leave the store alone: one login and one
         * timer go down while the other mailboxes serve out of the same database. The in-flight
         * cycle is AWAITED, not cancelled — a drain mid-batch has rows committed and a cursor
         * about to move, and dropping it re-reads mail already had. BOUNDED, because a half-open
         * link has nothing to end a command: three waits (the queue, an in-flight re-dial, and
         * `close()`'s LOGOUT) share one drain interval, and when it runs out the socket is
         * DESTROYED, ending the hung command.
         */
        async detach(leaving: "quit" | "restart", opts: { leaveSettings?: boolean } = {}) {
          /* The budget is armed by whichever stop method arrives first — `quiesce()` on the
             removal route, this one everywhere else. One drain interval for both waits. */
          box.stopLeft();                              // arms it where nothing has yet
          const by = (box.stopStartedAt as number) + scope.detachWaitMs;
          await detachBy(leaving, { passBy: by, goodbyeBy: by }, false, opts).done;
        },
        detachBy: (leaving: "quit" | "restart", by: DetachBounds, opts: { leaveSettings?: boolean } = {}) =>
          detachBy(leaving, by, true, opts),
        /**
         * The claim goes back; the row does not move (see `LocalMailboxRuntime.handBack`). Inside
         * `serialize`, so it cannot land between a gate's claim and the drain that claim authorises.
         * `releaseOwnClaim` is the same function the detach arm and release route call — a caller,
         * not a second way to give a claim up. `organizing` goes false whatever the release
         * answered: `drain` decides organizer-only work from it and the caller is an app about to
         * suspend, so "organizing" over a stopped process is the two-organizers reading. The ANSWER
         * only decides whether the caller may report the mailbox handed back — `null` means it may not.
         */
        /* THE LATCH ALONE — see `LocalMailboxRuntime.leave`. The same two lines `handBack` opens
           with; a release or a resume follows from the caller. */
        claimOnCandidate: box.claimOnCandidate,
        leave() {
          if (box.stopped) return;
          box.handedBack = true;
          /* A ring's timer cancelled here never fires, so its flag goes with it: left set, every
             later `schedule()` and ring returns at it and the resumed mailbox never polls again. */
          if (box.timer) { clearTimeout(box.timer); box.timer = null; }
          box.wakePending = false;
          box.ringQueued = false;
        },
        async handBack() {
          if (box.stopped) return 0;
          /* THE LATCH, BEFORE THE QUEUE and in the caller's tick. A drain in flight stops at its
             next cycle edge on it, and no poll re-arms behind it; the release below then goes
             out over the live connection with no timer between the edge and it. A timer here
             never fires on a phone whose timers are paused, which is where this is called. */
          box.handedBack = true;
          if (box.timer) { clearTimeout(box.timer); box.timer = null; }
          box.wakePending = false;
          box.ringQueued = false;
          return box.serialize(async () => {
            if (box.stopped) return 0;
            /* The release arm's rule: the settings first, while the claim is still ours — on the
               connection the release itself goes out on, so a dead runtime socket costs neither.
               They carry the instant this install let go (the latch above stopped its drains), one
               key for the whole hand-back, so a second connection's flush finds it written. */
            let settingsLeft = undefined as Awaited<ReturnType<typeof box.profileSync.flushBeforeLeaving>> | undefined;
            const leaving = await box.lettingGo();
            /* Owed while this install organizes the mailbox: a hand-back no connection could run it on did not save. */
            const flushOwed = box.organizer.organizing && box.organizer.claimed;
            const ask = async (conn: MailboxAdapter) => {
              if (box.organizer.organizing && box.organizer.claimed) {
                settingsLeft = await box.profileSync.flushBeforeLeaving(box.leasePermit, conn, leaving);
              }
              return releaseOwnClaim(
                conn, scope.installId, mb.id, { current: box.leaseNonce, minted: box.leaseMinted }, scope.log,
                "this install was asked to hand the mailbox back and the claim could not be "
                  + "removed; it ages out of ohmail/_meta on its own and another install takes the "
                  + "mailbox then",
              );
            };
            /* ON A LIVE CONNECTION. A hand-back queued behind a drain the platform froze runs at the
               thaw, on a socket the server has long dropped: a known-dead or unanswering runtime
               socket gets one fresh dial of its own, closed after the release. */
            let releasedAnswer = box.connectionDeadSince === null ? await ask(box.adapter) : null;
            if (releasedAnswer === null) {
              const fresh = config.adapterFactory
                ? config.adapterFactory(box.imapConfig, ONE_SHOT_DIAL)
                : new ImapAdapter(box.imapConfig, ONE_SHOT_DIAL);
              try {
                if (box.signedOutSinceDial()) throw new SignedOutError();
                await box.pinPlaintextDial(box.imapConfig);
                await fresh.connect();
                releasedAnswer = await ask(fresh);
              } catch (err) {
                scope.log("organizer_claim_release_failed", {
                  err, mailboxId: mb.id,
                  reason: "the hand-back could not open a connection to remove the claim; it ages "
                    + "out of ohmail/_meta on its own and another install takes the mailbox then",
                });
              } finally {
                void Promise.resolve(fresh.close()).catch(() => undefined);
              }
            }
            if (settingsLeft === undefined && flushOwed) settingsLeft = box.profileSync.flushNotRun();
            // The settings' last answer, once: a fresh connection's flush may have written what the dead one could not.
            if (settingsLeft !== undefined) box.settingsNotLeft(settingsLeft, "background");
            /* A sibling refusal at a hand-back is a COMPLETE answer that none of this runtime's
               claims stand (`0`), not a "could not look": the record it saw is a clone's, live,
               and not this install's to remove (mail 0121). The release ROUTE is where that refusal
               earns the row's `release_refusal`; a hand-back neither makes nor spends a stop. */
            const released = releasedAnswer === "sibling" ? 0 : releasedAnswer;
            if (released !== null && released > 0) {
              scope.log("organizer_claim_handed_back", {
                mailboxId: mb.id,
                claims: released,
                reason: "the app is leaving the foreground and cannot organize while it is not "
                  + "running, so the claim is given back rather than left to age out. The row is "
                  + "untouched: this install is still the organizer of record and the next gated "
                  + "cycle claims the mailbox again unless another install has taken it",
              });
            }
            /* THE NONCE GOES WITH THE CLAIM, and what it buys is the STAND-DOWN'S OWN READING.
               `ownClaimTerm` answers `our_last_nonce` while this field still names a claim we
               armed and `no_armed_nonce` once it is null — and after a hand-back the second is the
               true one. It is also what a fresh launch holds, so a resume enters the gate in a
               launch's state. Removing this line reddens no cell: the next successful gate arms
               its own nonce over it, so the claim here is the log's truthfulness, not a defect. */
            box.leaseNonce = null;
            /* THE RING STAYS: a claim of ours the release could not remove is still ours. */
            /* CARRIED: a hand-back removes the CLAIM and deliberately leaves the row saying
               organizer, so it neither makes nor spends a person's stop. */
            box.organizer = { organizing: false, reason: null, heldBy: null, unreadableSince: null, unreadableReason: null,
              releaseRequestedAt: box.organizer.releaseRequestedAt,
              releaseRefusal: box.organizer.releaseRefusal, holderState: null,
              /* THE CLAIM WENT BACK, and this is the field that says so. The ROW is deliberately
                 untouched — the next resume takes the mailbox again with no press — so it is the
                 only fact separating a phone that gave the mailbox back from one that holds it. */
              claimed: false,
              ...(settingsLeft === undefined ? {} : { settingsLeft }) };
            /* THE LATCH AND THE TIMER WENT BEFORE THE QUEUE, and are not set again here: a
               `resume()` that ran after this call and before this body is the later instruction,
               and re-latching would undo it. See {@link handedBack}. */
            return released;
          });
        },
        /**
         * Take the mailbox back if nobody else has it — the other half of `handBack`. It clears the
         * hand-back and runs ONE forced, ordinary gated cycle: the gate reads `ohmail/_meta` and
         * either claims a free mailbox or stands this install down against a holder. No press, no
         * row write, no way to displace anybody — a resume that could take a mailbox from another
         * machine would be the press without the person. `force` for the resync route's reason (the
         * re-dial wait must not hold the first cycle). The cycle re-arms the poll timer `handBack`
         * cleared; `0` cycles means it could not be served, so the caller must not report it taken.
         */
        async resume() {
          /**
           * A START THAT DID NOT FINISH STARTING IS NOT A START, and the missing half was the TIMER.
           *
           * The poll was armed only on the returning exit, so a failure after the gate claimed left
           * this install holding the mailbox with nothing polling or renewing while the surface said
           * "organizing". It is armed on BOTH exits now. A cycle that failed is the poll's business:
           * a holder whose drain was refused is still the organizer, and giving the mailbox back
           * over a bad network hands it to another machine for a hiccup. What makes the reported
           * state unreachable is the PAIR — this timer, and `organizing` derived as a mask.
           */
          box.handedBack = false;
          /* No ring survives a hand-back (`leave`, `handBack`); cleared here too, for any path
             that cancelled a ring's timer without saying so. */
          box.wakePending = false;
          box.ringQueued = false;
          try {
            const served = await box.syncUntilQuiet(undefined, { force: true });
            /* `syncUntilQuiet` deliberately does not arm it — its own tail says so — and `handBack`
               cleared it. `schedule()` returns at `stopped` and at a hand-back latched since,
               so neither a stop nor a later hand-back is re-armed by a resume that raced it. */
            box.schedule();
            return served;
          } catch (err) {
            box.markLeaseRefused(err);
            box.schedule();
            scope.log("organizer_resume_cycle_failed", {
              mailboxId: mb.id,
              err,
              reason: "the forced cycle this resume ran did not complete; the poll is armed and "
                + "owns the retry, and what this install holds is unchanged — a claim is not given "
                + "back over a cycle that failed",
            });
            return 0;
          }
        },
        /* THE SAME LOOK THE POLL MAKES, THROUGH THE SAME ADAPTER — read at call time, because a
           re-dial replaces the binding and a captured one would peek down a dead socket. A stopped
           runtime answers `unreadable` rather than `free`: there is no connection to look with,
           and "we have no way to check" is the one thing that must not read as "nobody is there". */
        async peekOrganizer(): Promise<LeasePeekAnswer> {
          if (box.stopped) return { answer: "unreadable", op: "no_lease_peek_io", cause: undefined };
          return box.peekOrganizer();
        },
      };
      box.rt = rt;
}
