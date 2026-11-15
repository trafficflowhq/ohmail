import { randomUUID } from "node:crypto";
import {
  type OrganizerState, capabilitiesColumn, type Tx, type LedgerTx, type OrganizerRole,
  RELEASED_ORGANIZER_SEND_SENTENCE, type StandDownExport, exportPendingMovesOnStandDown, closeStoodDownAppointments,
} from "@trafficflow/db";
import { agreeSweepRun, makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { gapOpenStart, type TravelledGap } from "../gap-catchup.js";
import { dialect } from "@trafficflow/db/dialect";
import {
  refreshOrganizerHolder, readTravellingGapSince, markMailboxReleased, clearOrganizerStandDown,
  markMailboxStoodDown, type MailboxDisabledReason,
} from "../mailboxes.js";
import { readNewestSettings, sweepHeld } from "../profile.js";
import type { ProfileIo } from "@trafficflow/core/adapters/organizer-profile";
import {
  type LeaseSelf, type LeasePeekCapableAdapter, type OrganizerWriteAuthority, DEFAULT_STALE_AFTER_MS,
  readMailboxLease, acquireLeasePermit, releaseMailboxClaim,
} from "../lease.js";
import {
  makeClockCorrectionWatch, answerLeasePeek, type OrganizerIntent, readLeasePeek, resumesOwnClaim, withMinted,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxRuntime } from "../index.js";
import type { WorkerScope } from "./scope.js";

/** The worker's start function, one section: who may organize a mailbox: the claim's gate, the reader's look, the stand-down and the release. */
export function leaseGateSection(scope: WorkerScope): void {
    /* ONE WATCH FOR THE PROCESS — a wall clock that was SET, which is the one thing that can make
       a claim this worker wrote stop being evidence about the clock it has now. */
    const clockCorrections = makeClockCorrectionWatch();

    function leaseSelfFor(
      rt: { leaseNonce: string | null; leaseMintedNonces: readonly string[]; seenClockCorrections: number },
      correctionsNow: number,
    ): LeaseSelf {
      return {
        installId: scope.organizerInstallId,
        kind: "cloud",
        displayName: scope.organizerDisplayName,
        lastNonce: rt.leaseNonce,
        /* AND EVERY NONCE MINTED HERE, because an install recognises its own claim whatever happened
           to the response — see {@link LeaseSelf.mintedNonces}. */
        mintedNonces: rt.leaseMintedNonces,
        /* AND WHETHER OUR OWN RECORD IS STILL EVIDENCE ABOUT THIS CLOCK. Without it a corrected
           clock clears only at the next launch, and a long-lived worker never launches. */
        ...(correctionsNow !== rt.seenClockCorrections ? { clockCorrected: true } : {}),
      };
    }

    /**
     * A reader looks. It does not claim. The APPEND-less read of `ohmail/_meta`, run once per reader
     * cycle, whose whole product is the four holder columns — so the banner every client renders is a
     * ROW read rather than a live IMAP dial per viewer. `readLeasePeek` cannot create the folder or
     * write a claim; that narrowness is the enforcement (see `LeasePeekCapableAdapter`). NEVER throws:
     * a reader that could not look keeps reading mail, the columns keep their previous answer (at
     * worst one poll stale), and the alternative — treating an unreadable folder as evidence — is
     * exactly the conflation the lease forbids. It writes only when something CHANGED, so a reader
     * whose organizer is quietly renewing costs zero writes per cycle.
     */
    async function refreshReaderHolder(
      mb: { mailboxId: string; accountId: string },
      adapter: MailboxAdapter,
      current: {
        kind: string | null; name: string | null; since: Date | null; state: string | null;
        capabilities: string | null; installId: string | null;
        /** What this reader last wrote of the gap window (`gap_since`); undefined = not since attach. */
        gapOpen?: boolean;
        /** When this reader last looked (epoch ms); see the re-check below. */
        lastLookAt?: number;
      },
    ): Promise<void> {
      const peek = (adapter as Partial<LeasePeekCapableAdapter>).leasePeekIo;
      try {
        /* ── THE CONFIGURED WINDOW, and omitting it was a real divergence ─────────────────────
         *
         * The gate below is given `organizerStaleAfterMs`; both previews used to default to ten
         * minutes. With a 24-hour configured window and two installs each carrying a record 14–15
         * minutes old, the gate answered `stand_down` — held, per the configuration — while the
         * preview answered `stopped`, so this row was refreshed to say nobody organizes a mailbox
         * the same pass had just stood down from. The release certification below had the same
         * omission and the same cause, with a WRITE at the end of it. One window per mailbox, read
         * from one place; the sidecar already forwards its own (`engine.ts:3267`, `:3657`), which
         * is what made the difference legible. */
        /* THREE ANSWERS, AND THE MISSING ACCESSOR IS ONE OF THEM. This probed `leasePeekIo` and
           answered a failed probe with a bare `return` — no write, no line, and the four holder
           columns left saying exactly what an unorganized mailbox's say. Every banner in the
           product reads those columns, so an adapter without the read-only accessor renders
           "nobody organizes this mailbox" about a mailbox nothing has looked at. `answerLeasePeek`
           makes that an ANSWER; the row is still left alone, because a failed look is not evidence
           about who holds the mailbox. */
        const answered = await answerLeasePeek({
          io: typeof peek === "function" ? peek.call(adapter) : undefined,
          now: new Date(),
          ...(scope.organizerStaleAfterMs !== undefined ? { staleAfterMs: scope.organizerStaleAfterMs } : {}),
        });
        if (answered.answer === "unreadable") {
          scope.log.warn("organizer_holder_refresh_failed", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, op: answered.op,
            reason: "this reader could not look at the claim folder, so the holder columns keep "
              + "their previous answer; a look that did not land is not evidence that nobody "
              + "organizes this mailbox, and the next cycle looks again",
          });
          return;
        }
        const seen = answered.peek;
        // THE GATE'S HOLDER FIRST: `peekLease` sorts `holders` in the election's order, so the
        // name here is the install the gate elects. An empty list means the folder holds no
        // readable claim, which is reported as "nobody named" rather than invented.
        const top = seen.holders[0] ?? null;
        // `none` is not a member of the column's closed set and must not be coerced into one:
        // "nobody has ever organized this mailbox" is genuinely absent, not `stopped`.
        const state: OrganizerState | null =
          seen.state === "held" ? "held" : seen.state === "stopped" ? "stopped" : null;
        const name = top && top.displayName.trim() !== "" ? top.displayName.trim() : null;
        const kind = top === null ? null : top.kind;
        /* Mail 0092 — WHICH install, beside WHAT kind. Dropping the id here is what made the row
           unable to tell this deployment's own abandoned claim from another Cloud deployment's
           live one, and `lease.ts` scopes those ids by environment precisely so the two differ. */
        const installId = top === null ? null : top.installId;
        const since = top ? top.claimedAt : null;
        // Mail 0089 — the fifth holder column, computed the same way `refreshOrganizerHolder`
        // stores it: comma-joined, lowercased, empty ⇒ null. Compared here too, so a capability
        // added mid-tenure (a peer upgrading its build without a takeover) still lands on the row —
        // it just never stamps `organizer_event_at`, on the same argument `organizedSince` shifting
        // under a renewed tenure already makes below.
        const capabilities = top ? capabilitiesColumn(top.capabilities) : null;
        /* THE ID IS PART OF THE COMPARE, not just part of the write. This compare decides whether
           the row is already what the folder says, and a column missing from it is a column that
           can never be found stale: 0092 shipped with the id written but not compared, so every
           row that predated the migration kept a NULL id for ever — the five older columns already
           agreed, so this returned before the write on every cycle. NULL fails closed in the
           release arm, so the hand-back stayed refused on precisely the mailboxes it was for.
           Any holder column added after this one belongs on the roster and in this line. */
        /* THE WINDOW IS THE GAP THIS READER IS LOOKING AT NOW: a look that finds no live holder
           opens it once, a look that finds one closes it with its offer. Asked apart from the
           compare below, which reads an empty folder as equal to a row saying nobody holds it. */
        /* AFTER A QUIET STRETCH THE WINDOW IS WRITTEN AGAIN (RULING-026 lane A): a whole tenure can
           pass between two looks of a reader in backoff, and only a fresh write reads the key that
           tenure's release left. Idempotent when nothing changed. */
        const lookedAt = Date.now();
        const quiet = current.lastLookAt !== undefined && lookedAt - current.lastLookAt > 2 * scope.config.pollIntervalMs;
        current.lastLookAt = lookedAt;
        const gap = state === "held" ? (current.gapOpen === false ? undefined : "close" as const)
          : (current.gapOpen === true && !quiet ? undefined : "open" as const);
        /* WHERE IT OPENS: a stopped claim's last server stamp; otherwise the gap the last hand-back
           left in the settings document, read here and never written (a reader appends nothing). */
        let opensAt: ReturnType<typeof gapOpenStart> | undefined;
        if (gap === "open") {
          const beats = seen.holders.map((h) => h.heartbeat.getTime());
          let travelled: TravelledGap | null = null;
          let written: { by: string | null; at: Date } | null = null;
          const mkIo = (adapter as Partial<{
            profileIo(id: { installId: string; mailboxId: string }): ProfileIo;
          }>).profileIo;
          if (state === null && typeof mkIo === "function") {
            const left = await readNewestSettings(
              mkIo.call(adapter, { installId: "reader-profile-mirror", mailboxId: mb.mailboxId }),
              (event, detail) => { scope.log.info(event, { ...detail, mailboxId: mb.mailboxId, accountId: mb.accountId }); },
            );
            if (left !== null) written = { by: left.by, at: left.at };
            if (left?.gap) travelled = { since: new Date(left.gap.since), by: left.gap.by, at: new Date(left.gap.at) };
          }
          opensAt = gapOpenStart(dialect(scope.db as unknown as Tx), {
            occupancy: state === "stopped" ? "stopped" : "none",
            stoppedAt: beats.length === 0 ? null : new Date(Math.max(...beats)),
            travelled, written, self: scope.organizerInstallId,
          });
        }
        if (current.kind === kind && current.name === name && current.state === state
          && current.capabilities === capabilities && current.installId === installId
          && (current.since ? current.since.getTime() : null) === (since ? since.getTime() : null)) {
          if (gap !== undefined && await refreshOrganizerHolder(scope.db, mb.mailboxId, {
            kind, installId, displayName: name, claimedAt: since, state,
            capabilities: top?.capabilities ?? null,
          }, { fence: scope.fence, stateChanged: false, gap, ...(opensAt === undefined ? {} : { opensAt }) })) current.gapOpen = gap === "open";
          return;
        }
        /* Only an occupancy flip is an event (0.14.1). This function writes whenever ANY of the four
         * columns moved, and most of those movements are not news: a peer restarting shifts
         * `organized_since`, a machine being renamed shifts `organized_by_name`, and telling somebody
         * "another install organizes this now" for either would be the notice crying wolf — the
         * once-per-event promise is worth something only if what counts as an event is what a person
         * would call one. `held` ⇄ `stopped`, and either direction to or from "we have not looked",
         * ARE what the two reader sentences are about: somebody is organizing this, or somebody
         * stopped and you can claim it. */
        const stateChanged = current.state !== state;
        const landed = await refreshOrganizerHolder(scope.db, mb.mailboxId, {
          kind, installId, displayName: name, claimedAt: since, state,
          capabilities: top?.capabilities ?? null,
        }, { fence: scope.fence, stateChanged, ...(gap !== undefined ? { gap } : {}), ...(opensAt === undefined ? {} : { opensAt }) });
        if (gap !== undefined && landed) current.gapOpen = gap === "open";
        scope.log.info("organizer_holder_refreshed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId,
          organizerState: state, heldBy: name,
          reason: "this install reads this mailbox; the row now names who organizes it, so every "
            + "client's banner is a row read rather than an IMAP dial per viewer",
        });
        current.kind = kind; current.name = name; current.since = since; current.state = state;
        current.capabilities = capabilities; current.installId = installId;
      } catch (err) {
        // Deliberately swallowed — see the header. A reader that cannot read the lease keeps
        // reading mail.
        scope.log.warn("organizer_holder_refresh_failed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, err,
        });
      }
    }

    /**
     * THE LAST SETTINGS WRITE BEFORE A RELEASE (RULING-026 lane A, and a standing defect: Cloud never
     * flushed before letting go). It carries where the gap began, read from the row before the release
     * clears it, so the install that organizes next opens its window there. Never throws; a refused
     * write leaves the next look to open the window as before.
     */
    async function leaveSettings(rt: MailboxRuntime): Promise<void> {
      try {
        const gap = await readTravellingGapSince(scope.db, rt.mailboxId, scope.organizerInstallId);
        const left = await rt.profile.flushBeforeLeaving(rt.leasePermit, rt.adapter, gap === null ? undefined : { gap });
        scope.log.info("organizer_settings_left", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, outcome: left,
          reason: "the settings and where the gap began were written into the mailbox before its claim leaves",
        });
      } catch (err) {
        scope.log.warn("organizer_settings_left", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, outcome: "not_saved", err,
          reason: "the settings could not be written before the release; the release goes ahead",
        });
      }
    }

    /**
     * THE AGREE'S SWEEP, after a promotion and its hold preflight and on each organizing visit after
     * it while slices remain: `agreeSweepRun` decides whether the spent stamp was a person's first
     * agree and moves the counted set as intents (the reconciler moves them this cycle). One
     * settings-folder read per visit. Never throws: a failure leaves the letters to the Screener's
     * offer, said here.
     */
    async function agreeSweepVisit(rt: MailboxRuntime): Promise<void> {
      const sweep = rt.agreeSweep;
      if (!sweep) return;
      try {
        const clearance = await rt.profile.sweepClearance();
        const out = await agreeSweepRun(scope.db as unknown as Parameters<typeof agreeSweepRun>[0], {
          accountId: rt.accountId, mailboxId: rt.mailboxId, stamp: sweep.stamp, held: sweepHeld(clearance), now: new Date(),
          knowledgeFor: (tx) => makeDrizzleRepo(tx as unknown as Parameters<typeof makeDrizzleRepo>[0]),
          ledgerOf: (tx) => tx as unknown as LedgerTx,
          cursor: sweep.cursor,
          ...(scope.config.agreeSweepSlice !== undefined ? { slice: scope.config.agreeSweepSlice } : {}),
        });
        rt.agreeSweep = out.next === null ? null : { stamp: sweep.stamp, cursor: out.next };
        scope.log.info("organizer_agree_sweep", {
          // `moved` letters given to the Screener, `count` their senders — both on the logger's allowlist.
          mailboxId: rt.mailboxId, accountId: rt.accountId, outcome: out.verdict,
          moved: out.total, count: out.senders, slices: out.slices, done: out.next === null,
          why: clearance.kind === "unread" ? clearance.why : null,
        });
      } catch (err) {
        rt.agreeSweep = null;
        scope.log.warn("organizer_agree_sweep_failed", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, err,
          reason: "the agree's in-window letters were not given to the Screener; the Screener's offer still names them",
        });
      }
    }

    /**
     * Read the lease for one mailbox and, when it says no, make that durable. Returns `true` iff this
     * process may organize the mailbox right now — since mail 0083 the same question as "is this
     * install the ORGANIZER", and `false` is no longer "stop": it is `role: "reader"`, and the caller
     * keeps syncing. Throws {@link LeaseUnavailableError} when the lease could not be READ at all,
     * never a stand-down (that "somebody else holds this" and "I could not look" must not be reachable
     * from one another); both call sites exempt that class like `ClassifierFaultError`. `false` has
     * two causes deliberately answered as one — another organizer holds it, or nobody asked this
     * install to (a consent-less mailbox) — differing only in the ROW, which names a holder in the first. The demotion write is FENCED, but a fenced-out write still demotes IN THIS PROCESS.
     */
    async function mayOrganize(
      mb: { mailboxId: string; accountId: string },
      lease: {
        takeoverAuthorizedAt: Date | null; disabledReason: string | null;
        /** Mail 0104 — the VERB behind the stamp; see {@link MailboxRuntime.lease}. */
        takeoverIntent: OrganizerIntent;
        organizerRole: OrganizerRole;
        organizeConsentedAt: Date | null;
        /** Mail 0088 — "stop organizing this mailbox, keep my mail", honoured before anything. */
        releaseRequestedAt: Date | null;
        /** Set by the person's release and cleared by a promotion: a released row never resumes. */
        organizerReleasedAt: Date | null;
      },
      /** The holder the row names, as the last look wrote it ({@link MailboxRuntime.holderSeen}). */
      holder: { readonly installId: string | null; readonly state: string | null },
      nonce: {
        leaseNonce: string | null;
        leaseMintedNonces: readonly string[];
        seenClockCorrections: number;
        leasePermit: OrganizerWriteAuthority;
        /** Written when a promotion spends a stamp; see {@link MailboxRuntime.agreeStamp}. */
        agreeStamp?: Date | null;
        /** Written by every gate; see {@link MailboxRuntime.claimServerAt}. */
        claimServerAt?: Date | null;
      },
      adapter: MailboxAdapter,
      phase: "attach" | "cycle",
      /**
       * The mailbox's derived request key, or `null` when there is no shared secret (OAuth). It
       * decides ONE thing here: whether the claim this gate writes advertises `requests`. Passed
       * in rather than read, because the credential it comes from is decrypted at attach and this
       * function runs in both phases — at attach the runtime does not exist yet.
       */
      requestKeyForGate: string | null,
      /**
       * THE SETTINGS FLUSH A RELEASE OWES, run first in the release arm while the claim is still ours
       * ({@link leaveSettings}). Only a visit whose previous cycle organized passes it.
       */
      leaving?: () => Promise<void>,
    ): Promise<boolean> {
      /* The release is honoured FIRST, before the lease is read at all (0.14.1). "Stop organizing and
       * keep my mail" is not a question for the lease — the answer is nobody, the person withdrew the
       * entitlement. It is first because `readMailboxLease` below APPENDS: an install that read the
       * lease first would renew its claim and release it one statement later, advertising itself as
       * the organizer of a mailbox it has been told to stop, once per cycle. The three writes are
       * ordered: the CLAIM first (while the connection that can expunge it is open —
       * `releaseOrganizerClaim`, or a fresh claim stands another install down for the staleness
       * window); the ROW second (what makes the release durable, and what `closeStoodDownAppointments`
       * reads); the APPOINTMENTS last (the other order closes nothing, silently). A failed release does NOT abort the ceasing — this install has stopped organizing whichever way the writes went.
       */
      if (lease.releaseRequestedAt !== null) {
        // Document first, claim second: a decision since the debounced write, and where the gap began.
        await leaving?.();
        const removed = await releaseOrganizerClaim(
          // The nonce this gate's carrier holds. On the ATTACH path no gate has run yet, so it is
          // `null` and the release refuses rather than deleting by id — the request stands and the
          // lapse bound below records it once the claim stops being renewed.
          {
            mailboxId: mb.mailboxId, accountId: mb.accountId, adapter,
            leaseNonce: nonce.leaseNonce,
            /* AND THE ONES LOST ANSWERS LEFT. A stop that cleared every claim except the record
               actually holding the mailbox is the shape this closes. */
            leaseMintedNonces: nonce.leaseMintedNonces,
          },
          "the person asked this install to stop organizing this mailbox and keep reading it",
        );
        /* Zero claims removed is not a release. The release is authorized from the row as it stood
         * when the person pressed and carried out a cycle later, and the mailbox can change hands in
         * between — another install expunges this one's claim — so the removal above (matched on OUR
         * install id) removes nothing and used to say nothing about it. `markMailboxReleased` then ran
         * anyway and nulls all six holder columns, so the row said nobody organizes this mailbox while
         * another install actively did (every banner is a row read) — the install-id defect one layer
         * down. So the row is stamped released only when our claim was actually taken out, or the
         * folder holds NOBODY; a foreign claim leaves the request standing, re-honoured next cycle,
         * healing when the foreign claim goes, with the holder columns still naming the real holder.
         */
        /* The folder decides, not the count. The first cut asked the peek only when the removal
         * returned ZERO, which left the defect one case over: if another install appends its claim
         * while ours is still there, removing ours returns ONE, the count looks like success, and the
         * row is cleared over a claim still in the folder. A positive count says our claim went, not
         * that the mailbox is free. So the folder is read after every removal and the row is stamped
         * only when nothing else holds it. Four things withhold: a LIVE foreign claim; UNREADABLE
         * claims (a `MalformedClaim` is EVIDENCE, not nothing); a folder we could not read at all; an
         * adapter with no read side (unreachable in production, withheld not assumed). A STALE foreign
         * claim does NOT withhold — it is a corpse the takeover path steps over.
         */
        let mayMark = false;
        /**
         * A LIVE HOLDER THIS PASS ACTUALLY SAW — the one withholding reason the lapse bound below
         * may not step over. The others ("could not read the folder", "records we cannot parse",
         * "no peek on this adapter") are all forms of not knowing; this one is knowing.
         */
        let sawLiveHolder = false;
        /* The peek is NOT gated on our removal, and that matters since the nonce scope. It used to
         * sit inside `if (removed !== null)`, on the reading that a failed removal left nothing to
         * certify; a release addressed by (install, nonce) added a THIRD outcome — an install that
         * cannot name its claim refuses, `removed` is `null`, and the peek never ran, so
         * `sawLiveHolder` stayed false and the lapse bound stamped "nothing organizes this" while
         * another install actively did (`release-stranded-claim.test.ts`'s holder case went red in
         * exactly that direction). The peek answers "is this mailbox free?", not "did our delete
         * land", so it is asked whenever the adapter can answer it; `mayMark` still requires our own
         * removal, the part that was never the peek's to decide. */
        {
          const peek = (adapter as Partial<LeasePeekCapableAdapter>).leasePeekIo;
          if (typeof peek === "function") {
            try {
              /* The CONFIGURED window, for the reason given at the reader-holder refresh above —
                 and it matters more here, because this read decides whether to STAMP the mailbox
                 released. Defaulting to ten minutes against a longer configured window reported no
                 fresh holder for a mailbox the gate still considers held, and `mayMark` below then
                 certified a release while another install was inside its own lease. */
              const seen = await readLeasePeek({
                io: peek.call(adapter), now: new Date(),
                ...(scope.organizerStaleAfterMs !== undefined ? { staleAfterMs: scope.organizerStaleAfterMs } : {}),
              });
              /* ANY LIVE CLAIM STOPS THIS, INCLUDING ONE CARRYING OUR OWN ID. Excluding our own
                 was wrong in a way the word "foreign" hid: `releaseMailboxClaim` removes the
                 claims it SAW in its own `listClaims`, so a claim appended after that read —
                 by an overlapping worker of this same deployment, or by anything else writing
                 our id — survives the removal. The peek then saw it, called it ours, and the row
                 was stamped free while a fresh claim stood every other install down.
                 What has to be true before saying "nobody organizes this" is that the folder
                 holds no live claim at all. A surviving claim of ours is not an exception to
                 that; it is an unfinished release, and the next cycle removes it. */
              const live = seen.holders.find((h) => h.fresh);
              sawLiveHolder = live !== undefined;
              mayMark = removed !== null && live === undefined && seen.unreadable === 0;
              if (!mayMark) {
                scope.log.info("organizer_release_withheld", {
                  mailboxId: mb.mailboxId, accountId: mb.accountId,
                  holder: live?.installId ?? null, unreadable: seen.unreadable,
                  reason: "the mailbox is not free, so this install must not report it as free; "
                    + "the request stands and is honoured again when the folder says otherwise",
                });
              }
            } catch (err) {
              scope.log.warn("organizer_release_peek_failed", {
                mailboxId: mb.mailboxId, accountId: mb.accountId, err,
                reason: "the release is left pending rather than certified against a folder that "
                  + "could not be read",
              });
            }
          }
        }
        /* A lapse bound, so "stopping on the next pass" cannot stand for ever. Every withholding path
         * above is honest and UNBOUNDED — a folder over the read ceiling never completes the read that
         * confirms the release, so the pane says "Stopping on the next pass" until somebody empties the
         * folder by hand. The bound is the staleness window (the window after which no install honours
         * a record), and this arm RETURNS AHEAD OF THE GATE, so a pending release means our claim has
         * not been renewed since it was asked — un-renewed for a whole window, it has aged out on its
         * own and the release is a fact (the sidecar's `releasedByLapse`, its reasoning). It COMPLETES
         * one already asked for, never flips one; `TF_LEASE_STALE_MS` is the one knob. It does NOT step
         * over a holder we saw — the bound is for NOT KNOWING, and a seen holder is knowing.
         */
        const lapseMs = scope.organizerStaleAfterMs ?? DEFAULT_STALE_AFTER_MS;
        const releasedByLapse = !mayMark && !sawLiveHolder
          && Date.now() - lease.releaseRequestedAt.getTime() >= lapseMs;
        if (releasedByLapse) {
          scope.log.info("organizer_released_by_lapse", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, lapseMs,
            reason: "this install was asked to stop organizing this mailbox and the folder never "
              + "confirmed its claim was removed; the claim has now been un-renewed for longer "
              + "than any install honours one, so the release is recorded as done",
          });
        }
        let stamped = false;
        if (mayMark || releasedByLapse) try {
          const written = await markMailboxReleased(scope.db, mb.mailboxId, { fence: scope.fence });
          if (written) {
            stamped = true;
            // The in-memory mirror of what the row now holds, on the same discipline the
            // stand-down arm keeps: this pass's own later reads must not act on a value the write
            // has just replaced, and the next cycle must not re-honour a request that is spent.
            lease.releaseRequestedAt = null;
            lease.takeoverAuthorizedAt = null;
            lease.organizerRole = "reader";
            lease.organizerReleasedAt = new Date();
          } else {
            scope.log.info("organizer_release_write_fenced", {
              mailboxId: mb.mailboxId, accountId: mb.accountId,
              reason: "the mailbox is a tombstone, or this instance no longer leads the shard",
            });
          }
        } catch (err) {
          scope.log.error("organizer_release_write_failed", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            reason: "this process has stopped organizing the mailbox and its claim is gone; the "
              + "row could not record it, so the next cycle honours the request again",
          });
        }
        // The sentence is the RELEASE's, not a stand-down's: nobody took this mailbox, so
        // "schedule it again where the mailbox is organized now" would name a place that does not
        // exist. See `RELEASED_ORGANIZER_SEND_SENTENCE`.
        await standDownAppointments(
          mb, "organized_elsewhere:unknown", RELEASED_ORGANIZER_SEND_SENTENCE,
        );
        /* THE SENTENCE ONLY GOES IN THE LOG IF IT IS TRUE. This fired unconditionally — after a
           withheld write, after a fenced write, after a write that threw — so the log said the
           person had stopped organizing the mailbox in exactly the cases where the row still said
           otherwise. A log line that reports an outcome has to read the outcome. */
        if (stamped) {
          scope.log.info("organizer_released", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
            reason: "the person stopped organizing this mailbox here; the row keeps its "
              + "credentials, its consent and its mirror, and this install reads it from now on",
          });
        } else {
          scope.log.info("organizer_release_pending", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
            reason: "this install has stopped organizing, and the row does not yet record the "
              + "release; the request stands and is honoured again next cycle",
          });
        }
        return false;
      }
      /* A consent-less mailbox is never promoted by an empty folder. `decideLease`'s first arm
       * organizes a mailbox with ZERO claims ("nobody has ever organized this"), the right answer for
       * a mailbox somebody asked us to organize and a SEIZURE for one they merely connected.
       * `POST /mailboxes` now creates a consent-less reader precisely so a fresh connect moves
       * nothing, and without this line the first cycle would find an empty `ohmail/_meta`, claim it,
       * create the tree and file the backlog — before the person ever saw the consent screen. It sits
       * ABOVE the read because it is not a fact about the LEASE (the folder says what it says) but
       * about whether THIS install has been asked, which lives in the row. `takeover_authorized_at`
       * overrides it and must: that stamp IS the explicit human action, written beside consent in one tx.
       */
      if (lease.organizeConsentedAt === null && lease.takeoverAuthorizedAt === null) {
        scope.log.info("organizer_awaiting_consent", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
          reason: "nobody has asked this install to organize this mailbox, so it reads it and "
            + "moves nothing — an empty lease folder must not be read as permission",
        });
        return false;
      }
      /* A reader with no press never enters the gate. `readMailboxLease` is not a report — it runs the
       * WRITE gate, and `decideLease`'s arm 4 ("no readable claim, so nobody has ever organized this")
       * answers `organize` and APPENDS. That arm is correct for the question it is asked; the mistake
       * was asking it. A CONSENTED READER against an EMPTY `ohmail/_meta` is what the folder looks like
       * the moment the other organizer releases cleanly, so this gate ran arm 4 the next cycle, claimed
       * the mailbox and promoted the row — AUTO-RESUME WITH NO PRESS, sixty seconds after somebody
       * moved organizing away, and the release above reversed by the cycle that performed it. The
       * desktop door never had it (`reader-no-auto-resume.test.ts`). Nothing replaces the read: both
       * call sites already peek on `false` through `refreshReaderHolder`, so the banner stays fresh. `takeoverAuthorizedAt` is the exemption — that stamp IS the explicit human action.
       */
      /* …EXCEPT this install's own consented tenure whose claim lapsed with nobody's Stop (the self
       * race): the gate runs with no press, and rule 3 decides over a folder showing nobody else. */
      const resumesOwn = lease.takeoverAuthorizedAt === null && resumesOwnClaim({
        organizerRole: lease.organizerRole, organizeConsentedAt: lease.organizeConsentedAt,
        organizedByInstallId: holder.installId, organizerState: holder.state,
        organizerReleasedAt: lease.organizerReleasedAt, releaseRequestedAt: lease.releaseRequestedAt,
      }, scope.organizerInstallId);
      if (lease.organizerRole === "reader" && lease.takeoverAuthorizedAt === null && !resumesOwn) {
        scope.log.info("organizer_reader_peek_only", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
          reason: "this install reads this mailbox and nobody has asked it to organize it, so it "
            + "looks at the lease and never runs the gate — an empty folder is not permission",
        });
        return false;
      }
      /* What this claim will offer a reader (mail 0090). `requests` is advertised only while this
       * account HOLDS a request key, the only thing that lets this organizer tell a genuine reader's
       * decision from a message anyone with APPEND rights wrote — no key, no capability, a reader
       * refused honestly at its own door. MINTED here, not merely read, and only on THIS door: the
       * hosted database is where an account's key lives, so the hosted worker is the one process
       * entitled to create one; a LOCAL install must never mint its own (it would generate a key the
       * Cloud reader has never seen) and receives it over an authenticated call. So the answer is
       * unconditionally YES once the mint returns, and the `catch` is the interesting case: a key this
       * process could not read or create means the claim advertises NOTHING, the fail-safe direction. Read AFTER the reader peek-only return, so a mailbox this install merely reads mints no key.
       */
      // WHAT THIS CLAIM OFFERS A READER: `requests`, but only where a shared secret exists to
      // verify one with. The key is derived from the mailbox password at attach and carried on the
      // runtime; an OAuth mailbox has none, so this claim advertises nothing and a reader is
      // refused honestly at its own door.
      const hasRequestKey = requestKeyForGate !== null;

      // The instant the gate ASKED, captured once: the permit's TTL is measured from the look, and
      // a second clock reading taken after the round trip would date the receipt in the future.
      const gateAskedAt = new Date();
      /* ASKED ONCE PER GATE and compared against what this mailbox has acted on. */
      const correctionsNow = clockCorrections();
      const leaseArgs = {
        adapter,
        self: leaseSelfFor(nonce, correctionsNow),
        mailboxId: mb.mailboxId,
        hasRequestKey,
        // The no-seize-back rule. The stamp is what tells "the user just added this
        // mailbox to Cloud" apart from "the account was parked and came back", which are
        // otherwise identical to the gate.
        //
        // THE INSTANT AND NOT A FLAG (0.14.1). It is the row's own `takeover_authorized_at`,
        // handed over unchanged, because the election ranks presses against each other: what
        // decides a contest between this install and another one that has ALSO been pressed for is
        // which person pressed last, and a boolean cannot say.

        // AND THE VERB, which lets rule 6 refuse a press that asked only to JOIN a mailbox
        // somebody else is organizing. The two are one fact about one press.
        takeover: lease.takeoverAuthorizedAt
          ? { authorizedAt: lease.takeoverAuthorizedAt, intent: lease.takeoverIntent }
          : null,
        ...(scope.organizerStaleAfterMs !== undefined ? { staleAfterMs: scope.organizerStaleAfterMs } : {}),
        ...(scope.config.organizer?.leaseResidue !== undefined ? { residue: scope.config.organizer.leaseResidue } : {}),
        log: (event: string, detail: Record<string, unknown>): void => {
          scope.log.info(event, { ...detail, mailboxId: mb.mailboxId, accountId: mb.accountId });
        },
      };
      const outcome = await readMailboxLease({
        ...leaseArgs, now: gateAskedAt,
        onNonceMinted: (minted: string) => { nonce.leaseMintedNonces = withMinted(nonce.leaseMintedNonces, minted); },
      });
      /* SPENT BY THE GATE THAT READ IT, and only once it RETURNED — a cycle that threw never
         offered the correction to the lease. */
      nonce.seenClockCorrections = correctionsNow;

      nonce.claimServerAt = outcome.organize ? outcome.claimServerAt ?? null : null;
      if (outcome.organize) {
        nonce.leaseNonce = outcome.nonce;
        /*
         * THE ROW FOLLOWS THE CLAIM, WITH NOTHING AWAITED BETWEEN THEM. `readMailboxLease` above
         * appended this install's claim and verified it, so the mailbox is already ours to every reader
         * of `ohmail/_meta`; `organizer_role` is the authority every write door consults, so a row still
         * saying `reader` here is this process answering its own requests `409 organized_elsewhere`,
         * naming itself. It sat AFTER `acquireLeasePermit`, behind one IMAP STATUS — a measured 88 ms of
         * exactly that state per becoming. The permit's baseline is now issued with the claim and
         * awaited after this write, so it costs this row nothing. The permit is a per-pass WRITE
         * RECEIPT; the ROW records who organizes the mailbox.
         */
        if (lease.takeoverAuthorizedAt || lease.disabledReason || lease.organizerRole === "reader") {
          try {
            /* ONE-SHOT: the authorization bought this becoming and no other, or a
             * lapse-then-resubscribe would seize the mailbox back months later from whatever a
             * human deliberately moved it to. And FENCED — `false` is a write that did not land
             * (this instance no longer leads the shard, or the row is a tombstone), so the
             * in-memory mirror may not say it did: flipping it regardless left this process
             * believing it had promoted a row that still said `reader`, with the press spent.
             */
            /* AND THE ONE-SHOTS AS THIS GATE READ THEM. The release arm above ran on the values
             * in `lease`, and the IMAP round trip since is a window a person can press a button
             * in: an unconditional clear here erased a Stop pressed during it, and the mailbox
             * organized on for ever. See `spendOneShot`. */
            const spent = lease.takeoverAuthorizedAt;
            const promoted = await clearOrganizerStandDown(scope.db, mb.mailboxId, { fence: scope.fence, asRead: lease });
            if (promoted) {
              // The sweep after the hold preflight asks whether this stamp was a person's first agree.
              if (spent !== null) nonce.agreeStamp = spent;
              if (resumesOwn) {
                scope.log.info("organizer_own_claim_resumed", {
                  mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
                  reason: "this install's own claim had lapsed with nobody else holding the mailbox "
                    + "and nobody having stopped it, so it organizes it again with no press",
                });
              }
              lease.takeoverAuthorizedAt = null;
              lease.disabledReason = null;
              lease.organizerReleasedAt = null;
              // The row now says `organizer`, so the next cycle issues no second UPDATE — the
              // "no-op UPDATE every cycle" `clearOrganizerStandDown`'s header refuses to pay for.
              lease.organizerRole = "organizer";
            } else {
              scope.log.warn("organizer_promotion_fenced", {
                mailboxId: mb.mailboxId, accountId: mb.accountId,
                reason: "the row was not promoted — this instance no longer leads the shard, or "
                  + "the mailbox is a tombstone; the press is unspent and the next cycle retries",
              });
            }
          } catch (err) {
            // The gate already said organize and our claim is already written. Failing to spend
            // the stamp costs one more cycle of it being spendable, never correctness.
            scope.log.warn("organizer_promotion_failed", { mailboxId: mb.mailboxId, accountId: mb.accountId, err });
          }
        }
        // THE READ ABOVE IS THE PERMIT'S FIRST LOOK, adopted rather than repeated: the gate renews
        // our claim, so running it twice here is the same-millisecond self-stand-down
        // `MIN_PERMIT_TTL_MS` refuses. Every write in the cycle that follows asks this receipt.
        nonce.leasePermit = await acquireLeasePermit({
          ...leaseArgs, adopt: { outcome, at: gateAskedAt },
          /* The ring as it stands now, the gate's own mint included. */
          self: { ...leaseArgs.self, mintedNonces: nonce.leaseMintedNonces },
          /* THE NONCE THE PERMIT RENEWS IS THIS RUNTIME'S NONCE. A re-read past the deadline or
             the write count writes a new claim and expunges the old one; holding the old nonce
             made the next cycle's gate read this worker's own claim as a restored clone, stand it
             down, and leave a live claim with nobody behind it. See `LeasePermitInput.onRenew`. */
          onRenew: ({ nonce: renewed }) => {
            nonce.leaseNonce = renewed;
          },
          /* AND WHAT IT MINTED, before the append that carries it — so a renewal inside the permit
             whose answer is lost leaves this runtime able to name the claim it wrote. */
          onNonceMinted: (minted: string) => { nonce.leaseMintedNonces = withMinted(nonce.leaseMintedNonces, minted); },
        });
        return true;
      }

      /* The intents this process recorded and may no longer carry out. Between the takeover and this
       * poll the row still read `organizer`, so a paired device's forwarded move passed
       * `assertOrganizerRole` and was recorded as a local `folder_state` intent — a reader's
       * `reconcileFolders` skips it and the install that CAN perform it has never heard of it, so the
       * near side shows a move that never reaches the mail server. It travels now, as the
       * `message.move` request the door would have written. ON THE TRANSITION ONLY —
       * `lease.organizerRole` still holds what the row says and this gate answers `stand_down` every
       * cycle while a foreign claim stands, so an ungated export would mint a request per cycle.
       * Best-effort: this process has already stopped organizing the mailbox. */
      /* The handover rides the demotion's own transaction, and both halves are contingent. It used to
       * be a separate transaction ahead of the write, leaving two sequences open: a paired device's
       * forwarded move committing AFTER a handover read its pending set and BEFORE the demotion (the
       * host accepted the move, became a reader, and neither performed nor exported it); and the
       * handover's own failure swallowed, so a demotion was recorded with an export that did not
       * happen. One transaction closes both: `markMailboxStoodDown` takes `FOR UPDATE` first and
       * `assertOrganizerRole` takes `FOR SHARE` inside a forwarded-move transaction, so the lock is
       * granted only once every such write has committed, and one arriving after waits and is refused.
       * ON THE TRANSITION ONLY, or an ungated export would mint a request per cycle. */
      const wasOrganizer = lease.organizerRole === "organizer";
      /* A HOLDER RATHER THAN A `let`, so the read below is the handover's own answer and not a
         narrowing of the initializer: the assignment happens inside the transaction's callback. */
      const handed: { r: StandDownExport | null } = { r: null };
      scope.log.warn("organizer_stand_down", {
        mailboxId: mb.mailboxId, accountId: mb.accountId, phase,
        disabledReason: outcome.reason,
        // WHETHER THE OTHER ORGANIZER IS STILL RENEWING. The row cannot hold this — a disabled
        // mailbox leaves the roster, so nothing would ever refresh it — but the log can, and it
        // is the difference between "a live install holds this" and "an install stopped and left
        // its claim behind", which are the same `disabled_reason` and completely different
        // incidents.
        organizerState: outcome.state,
        // The claim's DISPLAY NAME is the only field of a foreign claim worth logging: it is
        // what the takeover prompt shows a human. The install id is an opaque handle and the
        // heartbeat is noise at this level.
        heldBy: outcome.by?.displayName ?? null,
        reason: "another organizer holds this mailbox; disabling it here and syncing nothing — " +
          "exactly one active organizer per mailbox is the invariant this enforces",
      });
      try {
        // The holder columns ride the SAME statement as the role : a row that says
        // `reader` without naming who organizes it is a banner with a blank in it, and the banner
        // reads the row precisely so no client has to dial IMAP to render one.
        const written = await markMailboxStoodDown(scope.db, mb.mailboxId, outcome.reason, {
          fence: scope.fence,
          // The one-shots as this gate read them, on the promotion's rule — see `spendOneShot`.
          asRead: lease,
          ...(wasOrganizer
            ? {
              also: async (tx: typeof scope.db): Promise<void> => {
                handed.r = await exportPendingMovesOnStandDown(tx as unknown as Tx, {
                  accountId: mb.accountId, mailboxId: mb.mailboxId, now: new Date(),
                  mintId: randomUUID,
                });
              },
            }
            : {}),
          by: {
            kind: outcome.by ? outcome.by.kind : null,
            // Mail 0092 — the winner's install id, so a stood-down row names WHICH install beat
            // it rather than only what sort of install it was.
            installId: outcome.by ? outcome.by.installId : null,
            displayName: outcome.by ? outcome.by.displayName : null,
            claimedAt: outcome.by ? outcome.by.claimedAt : null,
            state: outcome.state,
            capabilities: outcome.by ? outcome.by.capabilities : null,
          },
        });
        if (!written) {
          scope.log.info("organizer_stand_down_write_fenced", {
            mailboxId: mb.mailboxId, accountId: mb.accountId,
            reason: "the mailbox is a tombstone, or this instance no longer leads the shard; the "
              + "handover of pending local moves did not run either, and the instance that does "
              + "lead the shard stands the same mailbox down on its own next pass",
          });
        } else {
          /* THE ROW'S MIRROR, AS `markMailboxStoodDown` HAS JUST LEFT IT — and it moves only on a
             write that LANDED. It used to be set ahead of the write, which made the mirror say
             `reader` after a write that threw: the next cycle's transition gate then skipped the
             handover for ever, so one failed write stranded every pending intent. Leaving it at
             `organizer` costs one more cycle of this row admitting a forwarded move, and that
             move is exported by the retry. */
          lease.organizerRole = "reader";
          lease.organizerReleasedAt = null;
        }
        // Only when there was something to hand over: the overwhelming majority of stand-downs
        // have no pending intent and must stay silent.
        const r = handed.r;
        if (r !== null && (r.exported > 0 || r.unmappable > 0)) {
          scope.log.warn("organizer_stand_down_moves_handed_over", {
            mailboxId: mb.mailboxId, accountId: mb.accountId,
            exported: r.exported, already: r.already, unmappable: r.unmappable,
            reason: "these moves were recorded here before the lease was read again; each is now a "
              + "request for the install that holds the mailbox. `unmappable` are intents this "
              + "handover cannot express — a desired folder no destination word covers, or a "
              + "message with no usable dedup key — and they stay pending exactly where they are",
          });
        }
      } catch (err) {
        scope.log.error("organizer_stand_down_write_failed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, err,
          reason: "neither the demotion nor the handover of pending local moves was recorded, so "
            + "the row still says this install organizes the mailbox; this cycle organizes "
            + "nothing and the next one demotes and hands over again",
        });
        return false;
      }
      // And the appointments this process can no longer keep are closed with a sentence. The mailbox
      // leaves the roster here (`loadEnabledMailboxes` excludes `disabled`) and a pending scheduled
      // send does not travel (the portable profile carries configuration, deliberately no drafts), so
      // the appointment is owed an ending now — see `closeStoodDownAppointments` for why FAILED rather
      // than handed over (an adopted appointment is two organizers holding one send). Best-effort, and
      // the hosted scheduled-send pass is the backstop. DELIBERATELY NOT FENCED: the fence arbitrates
      // Cloud against Cloud, but the LEASE said another organizer holds this, a fact any instance
      // reading `ohmail/_meta` reaches — and fencing it would break the ordinary case, since
      // `lifecycleWhere` refuses an already-disabled mailbox, so `markMailboxStoodDown` returns false
      // on every repeat and a close gated on that would never run for a long-stood-down mailbox.
      await standDownAppointments(mb, outcome.reason);
      return false;
    }


    /**
     * The stand-down's appointment close. Its own function rather than four inline statements in
     * the gate, so the gate's stand-down arm still reads as one decision — and never throws, for
     * the reason its call site gives. `toStandDown`'s post-loop detach is deliberately NOT a
     * second call site: those runtimes are exactly the ones this gate already answered `false`
     * for, so the close has already run for each of them.
     */
    async function standDownAppointments(
      mb: { mailboxId: string; accountId: string }, reason: MailboxDisabledReason,
      /**
       * The RELEASE's sentence, when this close is a release rather than a stand-down (0.14.1).
       * Omitted, `reason` chooses — every pre-0088 caller. See `RELEASED_ORGANIZER_SEND_SENTENCE`
       * for why a release cannot quote a stand-down's: nobody took this mailbox, so "schedule it
       * again where the mailbox is organized now" names a place that does not exist.
       */
      sentence?: string,
    ): Promise<void> {
      try {
        const r = await closeStoodDownAppointments(scope.db as unknown as Tx, {
          accountId: mb.accountId, mailboxId: mb.mailboxId, reason, now: new Date(),
          ...(sentence !== undefined ? { sentence } : {}),
        });
        // Only when something closed: the overwhelming majority of stand-downs have no
        // appointment to close and must stay silent.
        if (r.closed > 0) {
          scope.log.warn("scheduled_sends_stood_down", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, closed: r.closed,
            disabledReason: reason,
            reason: "these scheduled sends were made by this organizer and cannot travel; each " +
              "is now an ordinary draft carrying the sentence its Drafts row quotes",
          });
        }
      } catch (err) {
        scope.log.error("scheduled_sends_stand_down_failed", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, err,
          reason: "a scheduled send this process can no longer make was not closed with its " +
            "sentence; the hosted pass refuses a disabled mailbox at due time and closes it there",
        });
      }
    }

    /**
     * Release the claim on a mailbox this process is no longer entitled to organize. The roster half
     * (the parked-accounts reader dropping a parked account's mailboxes out of `loadEnabledMailboxes`,
     * `reconcileRoster` detaching them) is not enough: a dropped row leaves a FRESH claim in
     * `ohmail/_meta`, and a fresh Cloud claim stands a desktop install down — the account is parked,
     * the user clicks "Organize from this Mac", and the button appears to do nothing for the staleness
     * window. So the claim is deleted while the connection that can delete it is open. This is the
     * ONLY teardown path that releases: `detach` is also reached by a connection error, quarantine,
     * lost lock and clean stop, and in every one Cloud intends to keep organizing. Best effort — a release that could abort a detach would be worse than the fault it reports.
     */
    async function releaseOrganizerClaim(
      /**
       * The three fields this needs, rather than a whole {@link MailboxRuntime} — which a runtime
       * still satisfies, so the roster's call sites are unchanged. Widened in 0.14.1 because the
       * release arm inside `mayOrganize` runs BEFORE a runtime exists on the attach path: it holds
       * the adapter and the two ids and nothing else, and building a runtime to satisfy a
       * parameter would be inventing state to describe a mailbox this process is giving up.
       */
      rt: {
        mailboxId: string; accountId: string; adapter: MailboxAdapter;
        /** The nonce of the claim being given up — a release is addressed by (install, nonce). */
        leaseNonce: string | null;
        /** And every one this process minted here, which lost responses leave standing. */
        leaseMintedNonces?: readonly string[];
      },
      why: string,
    ): Promise<number | null> {
      /* IT RETURNS THE COUNT NOW, and `null` for "could not look". This returned `void` and
         swallowed a removal of ZERO — see the caller for what that cost. The three answers are
         genuinely different: we removed our claim, our claim was not there, and we could not
         reach the folder. Collapsing the last two into the first is how a release got certified
         over somebody else's live claim. */
      try {
        /* BOTH SIDES OF THIS HUNK ARE LOAD-BEARING. Upstream widened `releaseMailboxClaim` to
           take the mailbox id; this lane changed the control flow so the COUNT is returned and a
           zero no longer returns early — the caller has to tell "removed our claim" from "our
           claim was not there". Keeping either alone silently loses the other. */
        /* THE NONCE THIS RUNTIME WROTE, so the delete names the claim this process holds and not a
           sibling lineage's. `null` — no gate has run on this runtime yet — refuses inside, and
           the lapse bound above records the release when the claim stops being renewed. */
        const released = await releaseMailboxClaim(
          rt.adapter, scope.organizerInstallId, rt.mailboxId, rt.leaseNonce,
          {
            // The CONFIGURED window, so the stale term and every other reader of this folder agree.
            ...(scope.organizerStaleAfterMs !== undefined ? { staleAfterMs: scope.organizerStaleAfterMs } : {}),
            ...(rt.leaseMintedNonces !== undefined ? { mintedNonces: rt.leaseMintedNonces } : {}),
          },
        );
        if (released > 0) {
          scope.log.info("organizer_claim_released", {
            mailboxId: rt.mailboxId, accountId: rt.accountId, claims: released, reason: why,
          });
        }
        return released;
      } catch (err) {
        scope.log.warn("organizer_claim_release_failed", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, err,
          reason: "the claim will age out of ohmail/_meta on its own; until it does, a LOCAL " +
            "install that tries to take this mailbox over stands itself down again",
        });
        return null;
      }
    }
    scope.clockCorrections = clockCorrections;
    scope.refreshReaderHolder = refreshReaderHolder;
    scope.leaveSettings = leaveSettings;
    scope.agreeSweepVisit = agreeSweepVisit;
    scope.mayOrganize = mayOrganize;
    scope.releaseOrganizerClaim = releaseOrganizerClaim;
}
