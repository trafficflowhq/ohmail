import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  exportPendingMovesOnStandDown, RELEASED_ORGANIZER_SEND_SENTENCE, mailboxes, organizerDisplayName,
  capabilitiesColumn, organizerKindColumn, type MailboxDisabledReason, type Tx, recordMailboxProfileChange,
  type LedgerTx,
} from "@trafficflow/db";
import {
  readMailboxLease, acquireLeasePermit, DEFAULT_STALE_AFTER_MS, leaseBlockReason,
} from "@ohmail/organizer/lease";
import {
  answerLeasePeek, type LeasePeekIo, type LeasePeekAnswer, type LeaseOp, resumesOwnClaim,
} from "@trafficflow/core/adapters/organizer-lease";
import { OrganizerProfileSync, readNewestSettings, syncProfileMirror } from "@ohmail/organizer/profile";
import type { ProfileIo } from "@trafficflow/core/adapters/organizer-profile";
import {
  gapKeyFrom, gapOpenStart, handBackStart, heldElsewhereUntilOnLeave, instantOf, travellingGapColumns,
  type TravelledGap,
} from "@ohmail/organizer/gap-catchup";
import { dialect } from "@trafficflow/db/dialect";
import type { LocalRosterRow } from "./identity.js";
import type { SidecarConfig } from "./engine-types.js";
import { releaseOwnClaim, ownClaimTerm } from "./engine-local-services.js";
import { BAKED_ENGINE_VERSION } from "./engine-classifiers.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";

/**
 * The desktop's engine, one section: who may organize one mailbox: the settings' sync, the look at the holder, the
 * gate.
 */
export function claimSection(scope: EngineScope, box: MailboxScope, config: SidecarConfig, mb: LocalRosterRow): void {
      /**
       * The portable organizer profile — the LOCAL half, the same composition Cloud runs
       * (`@ohmail/organizer/profile`), handed this install's lease identity and this install's
       * store. One serialization of one store, or LOCAL and CLOUD would write documents that
       * disagree about the same configuration. Ticked only from `syncUntilQuiet` AFTER
       * `mayOrganize()` said yes — the single-writer discipline every organizer-side write
       * rides. The version is the app's own, as the bundler baked it (`"0.0.0"` only in an
       * unbundled dev run); provenance in the document, never a decision.
       */
      const profileSync = new OrganizerProfileSync({
        db: scope.db, accountId: scope.world.accountId, mailboxId: mb.id,
        /* AN ACCESSOR for `syncDeps.adapter`'s reason, and this object is the one that would have
           hidden the defect longest: `OrganizerProfileSync` keeps the deps record for the life of
           the attachment and reads `deps.adapter` per call, so a captured value would leave the
           write-behind publishing into a dead socket after a re-dial while every other pass had
           healed — a partial recovery, which is worse to diagnose than none. */
        get adapter() { return box.adapter; },
        self: { installId: scope.installId, kind: scope.organizerKind },
        producerVersion: BAKED_ENGINE_VERSION?.trim() || "0.0.0",
        ...(config.profileFlushIntervalMs !== undefined
          ? { flushIntervalMs: config.profileFlushIntervalMs } : {}),
        now: scope.now,
        log: scope.log,
      });

      /**
       * Read the lease. Returns false when this install must not organize, and makes that durable. The loser is a
       * READER: connected, poll timer running, mirror growing, `\Seen` its one IMAP write verb — not a stopped
       * install (this header once said the opposite, long enough that three call sites implemented that sentence).
       * The fear is answered by the ROLE, not by stopping: a reader's cycle skips `reconcileFolders`, the folder-ops
       * pass, the junk sweep, `ensureFolders`, the retro passes and the profile publish (`SyncDeps.role` carries the
       * whole list). `false` means "not the organizer", never "do nothing". The stand-down is sticky in the local row
       * (`status='disabled'` + reason) — the memory the mailbox cannot hold, since an empty `ohmail/_meta` reads as
       * "nobody has ever organized", which organizes. Only an explicit human action clears it.
       */
      /**
       * What the row already says the holder is, so the peek below writes only when something
       * CHANGED (0.14.1). The hosted twin (`index.ts#MailboxRuntime.holderSeen`) has carried
       * this since reader mode landed; this side wrote every poll instead. Seeded NULL rather
       * than from `world`, which does not carry the four columns — so the first peek of a launch
       * always writes, once, and every settled poll after it writes nothing. The first write's
       * `organizer_event_at` is stamped only if the occupancy differs from this seed — a launch
       * finding the same empty folder the row already recorded stamps nothing.
       */
      const holderSeen: {
        kind: string | null; name: string | null; since: Date | null; state: string | null;
        /** Mail 0089 — the fifth holder column, tracked beside the other four for the same reason. */
        capabilities: string | null;
        /** Mail 0092 — the SIXTH holder column, and the reason it is tracked here rather than
            written blind is the compare below: a column this snapshot does not carry cannot be
            found stale, so it is never corrected. That is exactly how the hosted twin shipped
            this column inert — written by every writer, compared by none, NULL for ever on every
            row that predated it, and a hand-back refused on precisely the mailboxes organized
            longest. */
        installId: string | null;
      } = { kind: null, name: null, since: null, state: null, capabilities: null, installId: null };
      /** Has a peek or the gate's lease read ANSWERED since attach — `LocalMailboxRuntime.holderLooked`. */
      box.holderLooked = false;
      /**
       * WHAT THIS READER LAST WROTE OF THE GAP WINDOW (`gap_since`): open, closed, or `null` for not
       * since attach or since it last organized, so the next look writes once either way. Its own
       * flag because the peek's change test reads an empty folder as equal to the NULL seed.
       */
      box.gapOpen = null;
      /** When this install last looked (epoch ms): a look after a quiet stretch writes the window again. */
      let lastLookAt: number | null = null;
      /** The role the last gated pass ran under — what `noteIdleOutcome` licenses the catch-up on. */
      box.lastPassOrganizing = false;
      /** The last gate's organize continued a claim this process still held in the folder (`continued`). */
      box.gateContinued = false;

      /**
       * An install that is not the organizer looks, and still does not claim. Two arms reach
       * it: a pre-consent install, and a demoted reader — which used to return without peeking,
       * so a demoted desktop's holder columns froze at the handover. The consent arm returns
       * BEFORE `readMailboxLease` (that function APPENDS on an empty folder), but the holder is
       * exactly what the pre-consent screens must say (`deriveOnboardingStep` row 3). So this is
       * the APPEND-less read (`readLeasePeek`, one method, no way to write — the narrowness is
       * the enforcement). Never throws: "could not look" and "nobody holds it" must not be
       * reachable from one another. Writes only on change.
       */
      /**
       * The engine's own APPEND-less look, in the three words a decision can be made from — and
       * the reason it is not {@link readLeasePeek} directly is the missing accessor. `leasePeekIo`
       * is probed structurally because `MailboxAdapter` does not declare it, and this call site
       * answered a failed probe with a bare `return`: the holder columns then said exactly what a
       * mailbox nobody has ever organized says, no line was logged, and `unreadableSince` — the
       * field that exists to tell a person the difference — stayed null. Measured: with that arm
       * taken, the phone's consent door admitted the press and wrote the consent.
       */
      const peekOrganizer = async (): Promise<LeasePeekAnswer> => {
        const peekIo = (box.adapter as Partial<{ leasePeekIo(): LeasePeekIo }>).leasePeekIo;
        /* ASKING FOR THE ACCESSOR CAN ITSELF REFUSE, and that is an ANSWER too. `ImapAdapter`
           asserts the adapter is usable before handing the io out, so a RETIRED one throws here —
           an ordinary runtime state, a mailbox detached while a press was in flight. Inside the
           poll that throw was caught by the surrounding try; the DOOR awaits this directly, so
           without this it would reject rather than refuse, and a rejection is not the 503 whose
           sentence tells a person to press again. */
        let io: LeasePeekIo | undefined;
        try {
          io = typeof peekIo === "function" ? peekIo.call(box.adapter) : undefined;
        } catch (err) {
          return { answer: "unreadable", op: "no_lease_peek_io", cause: err };
        }
        return answerLeasePeek({
          io,
          now: scope.now(),
          ...(config.leaseStaleAfterMs !== undefined ? { staleAfterMs: config.leaseStaleAfterMs } : {}),
          log: scope.log,
        });
      };

      /** The one place this runtime writes "the lease could not be read" — kept from the FIRST
       *  failure, so a surface can say how long; a look that answers clears it. */
      const markLeaseUnreadable = (err: unknown, op: LeaseOp): void => {
        box.organizer = {
          ...box.organizer,
          unreadableSince: box.organizer.unreadableSince ?? new Date().toISOString(),
          unreadableReason: leaseBlockReason({ op }),
        };
        scope.log("organizer_peek_failed", {
          err, op,
          reason: "this install reads this mailbox and could not see who organizes it; the row "
            + "keeps its previous answer, the pane says the lease is unreadable, and the next "
            + "pass looks again",
        });
      };

      const notePeekedHolder = async (reason: MailboxDisabledReason | null): Promise<void> => {
        try {
          await notePeekedHolderOnce(reason);
        } finally {
          box.holderLooked = true;
        }
      };
      const notePeekedHolderOnce = async (reason: MailboxDisabledReason | null): Promise<void> => {
        try {
          const answered = await peekOrganizer();
          /* THE THIRD ANSWER, AND IT IS NOT `free`. A look that did not happen leaves the four
             holder columns alone — a failed look is not evidence about who holds the mailbox —
             and says so where a person and the door can both read it. */
          if (answered.answer === "unreadable") {
            markLeaseUnreadable(answered.cause, answered.op);
            return;
          }
          const seen = answered.peek;
          /* THE GATE'S HOLDER FIRST — `peekLease` sorts them in the election's order, so this
             names the install the gate elects. An empty list is "nobody named", never invented. */
          const top = seen.holders[0] ?? null;
          /* `none` is not a member of the column's closed set: "nobody has ever organized this
             mailbox" is genuinely absent, not `stopped`. */
          const state = seen.state === "held" ? "held" : seen.state === "stopped" ? "stopped" : null;
          const name = top && top.displayName.trim() !== "" ? organizerDisplayName(top.displayName) : null;
          const kind = top === null ? null : top.kind;
          const since = top ? top.claimedAt : null;
          // Mail 0089 — the fifth holder column, computed the same way the hosted twin
          // (`index.ts#refreshReaderHolder`) does: comma-joined, lowercased, empty ⇒ null.
          const capabilities = top ? capabilitiesColumn(top.capabilities) : null;
          /* Mail 0092 — WHICH install holds it, beside WHAT KIND of install. `kind` is one of
             three words and answers "what sort of thing"; the hand-back needs "is this us", and
             those are the same question only when there is one install per kind. */
          /* NAMED `holderInstallId`, NOT `installId`, and that is not style. An outer
             `const installId = world.accountId` — THIS install's id — is in scope here, so a
             binding called `installId` shadows it only inside its own block and reads as the
             outer one everywhere else. Both are `string`-ish, so the mix-up TYPECHECKS: the
             first cut of this projection wrote this install's id into every row, including a
             peer's, which refreshes a peer's row on every poll and re-stamps
             `organizer_event_at` — the fifteen-second notice the compare exists to stop.
             Caught by renaming this binding and finding that nothing broke. */
          const holderInstallId = top === null ? null : top.installId;
          /* The REASON is the caller's, because the two arms that peek mean different things by
             the same four columns. A pre-consent install names no reason — nobody has stood
             anything down and putting "another install has claimed this mailbox" in front of
             somebody who simply has not finished setup would be false. A DEMOTED reader names the
             stand-down it remembers, so the pane keeps saying why it is not organizing. */
          box.organizer = { organizing: false, reason, heldBy: name, unreadableSince: null, unreadableReason: null,
            /* CARRIED: a peek reads the holder, never the row's own stop. */
            releaseRequestedAt: box.organizer.releaseRequestedAt,
            releaseRefusal: box.organizer.releaseRefusal,
            /* THE OCCUPANCY THIS READ SAW, beside the name it read: a holder that let go is
               `none`, and the phone's card says nothing organizes the mailbox, not "another". */
            holderState: seen.state,
            /* The two arms that peek are the two that hold nothing — a reader, and an install
               nobody has consented to. */
            claimed: false,
            /* CARRIED: what the last stop left in the settings document stands until this install
               claims again. A rung release pass followed by a forced cycle reads here second. */
            ...(box.organizer.settingsLeft === undefined ? {} : { settingsLeft: box.organizer.settingsLeft }) };
          /* Zero writes in the steady state, and the check is new (0.14.1). This block claimed
           * "only when something changed" and then wrote unconditionally — one UPDATE per
           * mailbox per poll for four values already there. The hosted twin
           * (`index.ts#refreshReaderHolder`) had the comparison and this side did not, and
           * nothing could notice: an idempotent write is invisible. It stops being invisible
           * the moment an event instant rides the same statement — without the comparison every
           * poll of a settled reader would stamp `organizer_event_at` and the notice would
           * reappear every fifteen seconds for ever.
           */
          const same = holderSeen.kind === kind && holderSeen.name === name
            && holderSeen.state === state && holderSeen.capabilities === capabilities
            && holderSeen.installId === holderInstallId
            && (holderSeen.since ? holderSeen.since.getTime() : null)
              === (since ? since.getTime() : null);
          /* THE WINDOW IS THE GAP THIS READER IS LOOKING AT NOW. A look that finds no live holder
             opens it once (`coalesce`, the store's own clock, the clock `created_at` is written
             with); a look that finds one CLOSES it with any offer made from it. Asked apart from
             `same`: an empty folder compares equal to the NULL seed. */
          /* AFTER A QUIET STRETCH THE WINDOW IS WRITTEN AGAIN (RULING-026 lane A): a hand-back's
             latch, the OS asleep or a long backoff can hide a whole tenure between two looks, and
             only a fresh write reads the key that tenure's release left. Idempotent otherwise. */
          const lookedAt = scope.now().getTime();
          const quiet = lastLookAt !== null && lookedAt - lastLookAt > 2 * scope.idlePollCeilingMs;
          lastLookAt = lookedAt;
          const opening = state !== "held" && (box.gapOpen !== true || quiet);
          /* WHERE IT OPENS: a stopped claim's last server stamp; otherwise the gap the last hand-back
             left in the settings document, read here and never written or cached. */
          let travelled: TravelledGap | null = null;
          let written: { by: string | null; at: Date } | null = null;
          if (opening && state === null) {
            const mkIo = (box.adapter as Partial<{
              profileIo(id: { installId: string; mailboxId: string }): ProfileIo;
            }>).profileIo;
            if (typeof mkIo === "function") {
              const left = await readNewestSettings(mkIo.call(box.adapter, { installId: "reader-profile-mirror", mailboxId: mb.id }), scope.log);
              if (left !== null) written = { by: left.by, at: left.at };
              if (left?.gap) travelled = { since: new Date(left.gap.since), by: left.gap.by, at: new Date(left.gap.at) };
            }
          }
          const beats = seen.holders.map((h) => h.heartbeat.getTime());
          const gapWrite = state === "held"
            ? (box.gapOpen === false ? null : { gapSince: null, gapLetters: null, gapPressedAt: null, gapStrangers: null })
            : (!opening ? null : {
              gapSince: gapOpenStart(dialect(scope.db), {
                occupancy: state === "stopped" ? "stopped" : "none",
                stoppedAt: beats.length === 0 ? null : new Date(Math.max(...beats)),
                travelled, written, self: scope.installId,
              }),
            });
          /* Mail 0169 — A LOOK THAT FINDS NO LIVE HOLDER ENDS A HELD STRETCH the row recorded: what this
             store took in by now was taken in while held, and the gap pass's clock allowance stops here. */
          const heldEnds = state === "held" ? {} : { heldElsewhereUntil: heldElsewhereUntilOnLeave(dialect(scope.db)) };
          if (same) {
            if (gapWrite !== null) {
              await scope.db.update(mailboxes).set({ ...gapWrite, ...heldEnds }).where(eq(mailboxes.id, mb.id));
              box.gapOpen = state !== "held";
              if (box.gapOpen) scope.gapOwed.add(mb.id);
            }
            return;
          }
          /* AN OCCUPANCY FLIP IS AN EVENT; A RENAME OR A NEW TENURE IS NOT. The hosted twin's
             argument verbatim: `held` ⇄ `stopped` (and either direction to or from "we have not
             looked") is what the reader's two sentences are about, while a peer restarting shifts
             `organized_since` and a machine being renamed shifts the name — neither is news, and
             telling somebody about them is the notice crying wolf. */
          const stateChanged = holderSeen.state !== state;
          await scope.db.update(mailboxes)
            .set({
              organizedByKind: kind,
              organizedByName: name,
              organizedSince: since,
              organizerState: state,
              // Mail 0089 — the fifth holder column, on the same read.
              organizedByCapabilities: capabilities,
              // Mail 0092 — the sixth, on the same read as the kind: the two must never disagree.
              organizedByInstallId: holderInstallId,
              ...(stateChanged ? { organizerEventAt: scope.now() } : {}),
              ...gapWrite,
              ...heldEnds,
            })
            .where(eq(mailboxes.id, mb.id));
          if (gapWrite !== null) { box.gapOpen = state !== "held"; if (box.gapOpen) scope.gapOwed.add(mb.id); }
          holderSeen.kind = kind; holderSeen.name = name;
          holderSeen.since = since; holderSeen.state = state;
          holderSeen.capabilities = capabilities; holderSeen.installId = holderInstallId;
        } catch (err) {
          /* And it is recorded where a person can see it, not only in a log. Keeping the row's
           * previous answer is right — a failed look is not evidence about who holds the
           * mailbox — but it left the STATE looking healthy: a reader whose lease reads keep
           * failing presented an ordinary connected pane with a stale holder, and the mark this
           * field exists for was set only on the startup path — the reliability-signal-as-
           * healthy-state shape surviving at poll time, where a mailbox spends its life.
           * `answerLeasePeek` answers the folder's own faults rather than throwing them, so what
           * reaches here is the WRITE below failing — which is still a pass that learned nothing. */
          markLeaseUnreadable(err, "list_claims");
        }
      };

      /**
       * WHERE THIS HAND-BACK SAYS THE GAP BEGAN (RULING-026 lane A), read from the row before the
       * release clears it: the key the release's flush leaves in the settings document, so the install
       * that organizes next opens its window there. Never throws; no key is the old behaviour.
       */
      const leavingGap = async (): Promise<{ gap: { since: string; by: string; at: string } } | undefined> => {
        try {
          const cols = travellingGapColumns(dialect(scope.db), { sibling: true });
          const [row] = await scope.db.select({ since: cols.since, at: cols.at }).from(mailboxes).where(eq(mailboxes.id, mb.id));
          const gap = row === undefined ? null : gapKeyFrom(row, scope.installId);
          return gap === null ? undefined : { gap };
        } catch (err) {
          scope.log("organizer_gap_read_failed", {
            err, reason: "where the gap began could not be read, so the settings leave without it",
          });
          return undefined;
        }
      };

      /**
       * THE INSTANT THIS INSTALL LETS GO WITHOUT A PRESS (RULING-026 lane A, as amended):
       * the app quitting and the phone leaving the foreground leave it in the settings document, the
       * document before the claim, so an install that slept through this turn counts from here and
       * never back over it. `at` is the engine's own clock, the one its claim was stamped with;
       * `since` is a Stop's start with `at` as the press ({@link handBackStart}, mail 0169), so it
       * never reaches back over a holder's turn this row recorded either.
       */
      const lettingGo = async (): Promise<{ gap: { since: string; by: string; at: string } }> => {
        const at = scope.now();
        // Unreadable, `at`: the turn ends now. The phone's hand-back keeps the row's values for the next one.
        let since = at.getTime();
        try {
          const d = dialect(scope.db);
          const [row] = await scope.db.select({ s: handBackStart(d, d.ts(at)) }).from(mailboxes).where(eq(mailboxes.id, mb.id));
          since = Math.min(instantOf(row?.s)?.getTime() ?? since, since);
        } catch (err) {
          scope.log("organizer_gap_read_failed", {
            err, reason: "where this turn's gap starts could not be read, so it starts at the instant this install let go",
          });
        }
        return { gap: { since: new Date(since).toISOString(), by: scope.installId, at: at.toISOString() } };
      };
      /** Such an exit's settings write did not land: said once, and the claim goes back regardless. */
      const settingsNotLeft = (
        left: Awaited<ReturnType<typeof profileSync.flushBeforeLeaving>>, phase: "quit" | "background",
      ): void => {
        if (left === "saved") return;
        scope.log("organizer_settings_leave_failed", {
          mailboxId: mb.id, phase, outcome: left,
          reason: "the settings and the instant this install let go could not be written into the "
            + "mailbox, so the claim goes back without them",
        });
      };

      const mayOrganize = async (): Promise<boolean> => {
        /* The stamp is re-read every run, and without this the poll destroys it.
         * `takeoverAuthorized` was derived once at assembly — harmless while a stood-down
         * install had no poll timer. A reader cycles now, turning dormant staleness
         * destructive: the poll asks the lease with `takeover: "none"`, is correctly refused by
         * the foreign claim the person is asking to take over, and the refusal arm CLEARS the
         * persisted stamp — the press consumed by the one pass that could not act on it. So the
         * row is asked again at the top of the gate: one indexed read per poll, which makes the
         * takeover route's promise a fact. Failure is not an error: an unreadable row leaves
         * the in-memory value, and a takeover deferred one poll beats a failed launch.
         */
        /** What the ROW says the role is, re-read every pass beside the stamp (0.14.1). */
        let rowRole: string = "organizer";
        /**
         * Did the read above actually land? — a `let` because the inferred default was measured to be a hole.
         * `rowRole` is a fresh optimistic literal per call, so a re-read that THREW left it saying
         * `"organizer"` and the gate ran the write gate anyway — the auto-resume this release exists to
         * close, reached through the read added to close it: the person releases, the row says `reader`, the
         * folder is empty, a later poll's point-read fails, and `decideLease`'s arm 4 hands the mailbox back
         * under a row that still says `reader` — moving mail on IMAP while its own API refuses every write.
         * So an unreadable row is treated as "do not claim": one deferred poll for an organizer (its claim
         * stays fresh for forty more renews) against a reversed human decision.
         */
        let rowRead = false;
        /** Mail 0088 — "stop organizing this mailbox and keep my mail", if it has been asked. */
        let releaseRequested: Date | null = null;
        /** This install's own claim lapsed with nobody's Stop on it ({@link resumesOwnClaim}). */
        let resumesOwn = false;
        try {
          const [row] = await scope.db.select({
            at: mailboxes.takeoverAuthorizedAt,
            // …AND THE CONSENT, in the same indexed read. See the arm below: this is the column
            // that separates "nobody has been asked" from "this install is the organizer", and
            // before it was read here NOTHING on this door read it at all.
            consentedAt: mailboxes.organizeConsentedAt,
            /* And the role, which is what the RAM memory was standing in for (0.14.1).
             * `priorStandDown` was a process-local `let`, and the arm it guarded was the whole
             * of "this desktop does not auto-resume". Two things were wrong with reading RAM
             * here: another writer moves this row (the local `organize here` door, a `DELETE`,
             * the Settings pane) and RAM does not hear about it; and a value that starts NULL
             * at assembly means the first pass after a press resolves from a snapshot taken
             * before it, so the gate's two halves can disagree about one row inside one cycle.
             * The row is the memory the mailbox cannot hold, so the row is what is read — one
             * indexed point-read per poll, in the same statement as the columns beside it.
             */
            role: mailboxes.organizerRole,
            // Mail 0104 — the VERB behind `at`, in the SAME statement for the reason every column
            // here is in it: the gate decides from one read of this row.
            intent: mailboxes.takeoverIntent,
            releaseAt: mailboxes.releaseRequestedAt,
            // The holder columns, so the peek below can tell a CHANGE from a no-op without a
            // second round trip — and so a value another writer moved is not compared against a
            // stale copy in this process.
            byKind: mailboxes.organizedByKind,
            byName: mailboxes.organizedByName,
            since: mailboxes.organizedSince,
            state: mailboxes.organizerState,
            // Mail 0089 — the fifth holder column, in the same read for the same reason.
            capabilities: mailboxes.organizedByCapabilities,
            // Mail 0092 — the sixth, in the same read for the same reason.
            byInstallId: mailboxes.organizedByInstallId,
            // The person's recorded Stop: a released mailbox never resumes by itself.
            releasedAt: mailboxes.organizerReleasedAt,
          })
            .from(mailboxes).where(eq(mailboxes.id, mb.id)).limit(1);
          if (row) {
            rowRead = true;
            if (row.role === "organizer") scope.organizedHereIds.add(mb.id);
            box.takeoverAuthorized = row.at !== null;
            box.observedTakeoverAt = row.at;
            /* A value outside the column's closed set cannot be written by this program; read as
               the verb that YIELDS rather than the one that displaces, which is the direction
               that cannot end with two organizers. */
            box.observedIntent = row.intent === "takeover" ? "takeover" : "join";
            box.consented = row.consentedAt !== null;
            rowRole = row.role;
            releaseRequested = row.releaseAt;
            holderSeen.kind = row.byKind;
            holderSeen.name = row.byName;
            holderSeen.since = row.since;
            holderSeen.state = row.state;
            holderSeen.capabilities = row.capabilities;
            holderSeen.installId = row.byInstallId;
            resumesOwn = row.at === null && resumesOwnClaim({
              organizerRole: row.role, organizeConsentedAt: row.consentedAt,
              organizedByInstallId: row.byInstallId, organizerState: row.state,
              organizerReleasedAt: row.releasedAt, releaseRequestedAt: row.releaseAt,
            }, scope.installId);
          }
        } catch (err) {
          scope.log("organizer_takeover_reread_failed", {
            err,
            reason: "the takeover request could not be re-read this cycle; the stamp stands on the " +
              "row and the next cycle asks again",
          });
        }

        /* THE STOP STANDING ON THE ROW, PROJECTED ONCE FOR EVERY LITERAL BELOW. `organizing`
         * answers what THIS PASS may arrange, and a pass honouring a release arranges nothing
         * whether or not the claim left `ohmail/_meta` — so the phone's adapter read
         * `organizing: false` as "the mailbox was let go" and reported a refused stop as a success.
         * Two questions need two fields; this is the second, the row's own `release_requested_at`.
         * DERIVED IN ONE PLACE and spent below, where the compare-and-set records the release. A
         * pass that could NOT read the row never reaches a literal that writes this: the `!rowRead`
         * arm returns by spreading the previous answer, and a carry term here would be a second
         * mechanism over that one. */
        let releaseStamp: string | null = releaseRequested?.toISOString() ?? null;

        /* The release is honoured first, before the lease is read at all (0.14.1). The hosted
         * twin's arm, verbatim: "stop organizing this mailbox and keep my mail" is not a
         * question for the lease, and reading the lease first would RENEW a claim this install
         * is about to delete — advertising a machine told to stop, once per poll, in somebody's
         * mailbox. Three writes in load-bearing order: the CLAIM while the connection that can
         * expunge it is open, then the ROW (what makes the ceasing durable and what
         * `closeStoodDownAppointments` reads), then the APPOINTMENTS — none may abort the
         * ceasing. The timer and the login stay, as on a stand-down: a release keeps the mirror
         * growing, the mail readable and the send path open — the whole difference from removal.
         */
        if (releaseRequested !== null) {
          /* THE SETTINGS GO FIRST, while the claim from the last organizing pass is still ours: a
             decision made since the debounced write would otherwise stay on this install only. */
          const settingsLeft = box.organizer.organizing && box.organizer.claimed
            ? await profileSync.flushBeforeLeaving(box.leasePermit, box.adapter, await leavingGap()) : undefined;
          const released = await releaseOwnClaim(
            box.adapter, scope.installId, mb.id, { current: box.leaseNonce, minted: box.leaseMinted }, scope.log,
            "the claim ages out of the mailbox on its own; until it does, another "
              + "install that tries to take this mailbox over stands itself down again",
          );
          /* "Could not look" is not "released", and this arm is the whole of that.
           * `releaseOwnClaim` answers a count of ours removed, `0` (a complete answer), or
           * `null` — the search refused, the walk short, the folder over its ceiling. What
           * stood here gated the log on `> 0` and the write on nothing, so `null` produced a
           * row byte-identical to a completed release: the pane said the mailbox was let go
           * while the claim stood in `ohmail/_meta` and every other install stood itself down
           * against it. So `null` records nothing — the next poll asks again. The pass still
           * ceases to organize: falling through to the lease read would renew the claim being
           * given up. `takeover_authorized_at` is not spent; `notePeekedHolder` is not called.
           */
          /* …and the retry is bounded by the lapse, or "stop" can never finish (0.14.1).
           * Measured on a real provider: the enumeration was refused on every poll — the arm
           * below, right per pass, was unbounded as a whole. The bound is the lease's own
           * arithmetic: a pass with a pending request never renews, so once
           * {@link lastLeaseRenewalAt} is `staleAfter` old every reader already treats the
           * claim as stale and takes the mailbox past it — organizing here has truthfully
           * ended, and the row flips exactly as a confirmed release does (the log names the
           * lapse). Inside the window the arm stands: flipping early would stand the other
           * machine down against a still-fresh claim. On restart `release_requested_at` bounds.
           */
          let releasedByLapse = false;
          if (released === null) {
            const staleAfterMs = config.leaseStaleAfterMs ?? DEFAULT_STALE_AFTER_MS;
            const lastRenewal = box.lastLeaseRenewalAt ?? releaseRequested;
            if (scope.now().getTime() - lastRenewal.getTime() >= staleAfterMs) {
              releasedByLapse = true;
            }
          }
          /* ── THE SIBLING REFUSAL IS ITS OWN ANSWER, AND THE ROW RECORDS IT (mail 0121) ──
             A fresh claim under this install's id and a nonce it never wrote is a restored image
             or clone, and the lease's own rule decides what happens: the request STANDS until the
             sibling's claim lapses (the stale term then releases it on an ordinary poll), and the
             person is owed the sentence. Deliberately NOT the local lapse flip below — that arm's
             own log says "stale for longer than any install honours one", which is false about a
             record the sibling renews — and before this arm the row flipped to "released" ten
             minutes into a clone fight. The column is the one wire fact the pane needs; the same
             compare-and-set as the release write, so a press that landed mid-enumeration is not
             overwritten — the next poll re-reads either way. */
          if (released === "sibling") {
            try {
              await scope.db.update(mailboxes)
                .set({ releaseRefusal: "sibling_lapse" })
                .where(and(
                  eq(mailboxes.id, mb.id),
                  sql`${dialect(scope.db).truncMs(mailboxes.takeoverAuthorizedAt)} is not distinct from ${dialect(scope.db).tsOrNull(box.observedTakeoverAt)}`,
                  sql`${dialect(scope.db).truncMs(mailboxes.releaseRequestedAt)} is not distinct from ${dialect(scope.db).tsOrNull(releaseRequested)}`,
                ));
            } catch (err) {
              scope.log("organizer_release_write_failed", {
                err,
                reason: "the sibling refusal could not be recorded on the row; the request still "
                  + "stands and the next poll asks the server and records it again",
              });
            }
            box.organizer = {
              organizing: false, reason: null, heldBy: null,
              unreadableSince: box.organizer.unreadableSince, unreadableReason: box.organizer.unreadableReason,
              /* Not ours any more in intent: the person pressed stop, and the only thing keeping
                 the mailbox organized is a claim this install may not delete. */
              claimed: false,
              releaseRequestedAt: releaseStamp,
              /* THE SAME FACT THE ROW JUST RECORDED, for the surface that reads this state. */
              releaseRefusal: "sibling_lapse",
              holderState: box.organizer.holderState,
            };
            return false;
          }
          if (released === null && !releasedByLapse) {
            /* The pipeline is told, or a reader's gate gets an organizer's cycle. This record is
               what the PANE renders and what the next pass's gate starts from; the drain of the
               pass this gate is running takes the answer as a value instead. `reason` is NULL:
               nobody else holds this mailbox, and naming a holder would put "another install
               has claimed this mailbox" in front of somebody whose own release has not
               finished. `unreadableSince` is CARRIED, not cleared — this pass did not read the
               lease, so it learned nothing that could clear a standing mark; and not set
               either — "the server would not enumerate our records" is not "we cannot see who
               organizes this mailbox". */
            box.organizer = {
              organizing: false, reason: null, heldBy: null,
              unreadableSince: box.organizer.unreadableSince, unreadableReason: box.organizer.unreadableReason,
              /* NOT OURS ANY MORE, whatever the folder still holds: the person pressed stop, so
                 nothing may start behind a notification on the strength of this claim. */
              claimed: false,
              /* AND THE STOP IS STILL STANDING, which is the whole of what a caller may not read
                 off `organizing` here: nothing was recorded, the claim is in the folder as far as
                 anybody knows, and the next poll asks the server again. */
              releaseRequestedAt: releaseStamp,
              releaseRefusal: box.organizer.releaseRefusal,
              holderState: box.organizer.holderState,
            };
            scope.log("organizer_claim_release_unconfirmed", {
              mailboxId: mb.id,
              reason: "this install was asked to stop organizing this mailbox and could not "
                + "confirm its claim is out of the mailbox, so nothing is recorded as released: "
                + "the mailbox stays organized here with the request still standing, this pass "
                + "arranges nothing and renews nothing, and the next poll asks the server again",
            });
            return false;
          }
          if (released !== null && released > 0) {
            scope.log("organizer_claim_released", {
              mailboxId: mb.id,
              claims: released,
              reason: "the person asked this install to stop organizing this mailbox; its claim "
                + "is out of the folder so another install can take it without waiting out the "
                + "staleness window",
            });
          }
          /* AND `0` FALLS THROUGH TO THE SAME WRITE, with no line of its own. A complete read
             that found none of ours means nothing of this install's is holding the mailbox — the
             thing the person asked for — so it is a release, and it is silent because there is no
             count to report and nothing an operator would act on. Treating it as a failure would
             strand the request for ever on a mailbox whose claim had already aged out: there
             would be nothing left for any later poll to remove. */
          try {
            /* And it yields to a press that landed while it was asking the server.
             * `releaseOwnClaim` is an IMAP round trip, and the route that writes
             * `takeover_authorized_at` stays answerable throughout ({@link observedTakeoverAt}),
             * so the gap between this pass reading the row and writing it is exactly where
             * "organize here again" lands — unguarded, this write deleted that press silently.
             * The update is a compare-and-set on the two columns this pass decided from,
             * yielding whole: an overtaken release records nothing. `IS NOT DISTINCT FROM`, not
             * `=` (SQL equality on two NULLs is NULL). Both columns, because the door that
             * accepts a press on a release-pending row also cancels the request in the same
             * transaction; the next pass's gate appends a fresh claim under the surviving stamp. */
            const [recorded] = await scope.db.transaction(async (tx) => {
              const rows = await tx.update(mailboxes)
              .set({
                organizerRole: "reader",
                // Nobody won this mailbox. Leaving the holder columns populated would put
                // "organized by <someone>" on a mailbox nothing is organizing, in front of the
                // person who just pressed the button that stopped it.
                organizedByKind: null,
                organizedByName: null,
                organizedSince: null,
                organizerState: null,
                // Mail 0089 — the fifth holder column goes with the other four; nobody won this
                // mailbox, so nobody offers anything.
                organizedByCapabilities: null,
                // Mail 0092 — nobody won it, so no id names anybody.
                organizedByInstallId: null,
                // Both stamps are spent. They are contradictory instructions about one mailbox, and
                // a release that left a becoming authorized would be promoted straight back by the
                // very next poll — the control undoing itself.
                releaseRequestedAt: null,
                // Mail 0121 — the refusal explains a STANDING request; a recorded release leaves
                // nothing standing to explain.
                releaseRefusal: null,
                takeoverAuthorizedAt: null,
                // AND THE RECORD THAT IT HAPPENED (0.14.1). The ask is gone; without this the
                // row is byte-identical to a stood-down reader whose winner has since gone away,
                // and the launch catch-up for orphaned appointments would stop running on it. See
                // `standDownMemory`'s released arm.
                organizerReleasedAt: scope.now(),
                organizerEventAt: scope.now(),
                /* AND THE GAP WINDOW OPENS WHERE THIS TENURE'S LAST FINISHED DRAIN BEGAN, never after the
                   person's press (mail 0151, 0169) — unless this row saw another holder since: a
                   sibling's refusal or a recorded holder starts it at the store's clock, never back
                   over that tenure. The columns are read before this statement clears them. */
                gapSince: sql`coalesce(${mailboxes.gapSince}, case when ${mailboxes.releaseRefusal} is null
                  and ${mailboxes.organizedByKind} is null and ${mailboxes.organizedByName} is null
                  and ${mailboxes.organizedByInstallId} is null then ${handBackStart(dialect(scope.db), sql`${mailboxes.releaseRequestedAt}`)} end,
                  ${dialect(scope.db).now()})`,
                organizedThrough: null,
                // Mail 0169 — a release past a holder this row recorded ends that held stretch.
                heldElsewhereUntil: heldElsewhereUntilOnLeave(dialect(scope.db)),
              })
              // At the reading's precision: the store keeps microseconds, the pass read a `Date`.
              .where(and(
                eq(mailboxes.id, mb.id),
                sql`${dialect(scope.db).truncMs(mailboxes.takeoverAuthorizedAt)} is not distinct from ${dialect(scope.db).tsOrNull(box.observedTakeoverAt)}`,
                sql`${dialect(scope.db).truncMs(mailboxes.releaseRequestedAt)} is not distinct from ${dialect(scope.db).tsOrNull(releaseRequested)}`,
              ))
              .returning({ id: mailboxes.id });
              if (rows.length > 0) await recordMailboxProfileChange(tx as unknown as LedgerTx, scope.world.accountId, mb.id);
              return rows;
            });
            if (recorded === undefined) {
              /* THE PRESS WON. Nothing is recorded and nothing is undone — the next poll re-reads
                 the row, finds the request gone and the stamp standing, and promotes. `organizing`
                 is false for THIS pass because the claim did come out of the folder a moment ago:
                 filing mail as an organizer with no claim in `ohmail/_meta` is the one state worse
                 than a pass that arranges nothing. `unreadableSince` is carried, not cleared — see
                 the unconfirmed arm above for why a pass that read nothing may not clear a mark. */
              box.organizer = {
                organizing: false, reason: null, heldBy: null,
                unreadableSince: box.organizer.unreadableSince, unreadableReason: box.organizer.unreadableReason,
                /* The claim did come out of the folder a moment ago; the next poll's gate appends
                   a fresh one under the surviving press and sets this again. */
                claimed: false,
                /* NOTHING IS RECORDED AND NOTHING IS SPENT, so the stamp stands exactly as this
                   pass read it — the row moved under the write, and the next poll re-reads it. */
                releaseRequestedAt: releaseStamp,
                /* The press that moved the row cleared the refusal with the request it cancelled. */
                releaseRefusal: null,
                holderState: box.organizer.holderState,
              };
              scope.log("organizer_claim_release_yielded_to_press", {
                mailboxId: mb.id,
                reason: "this install was asked to stop organizing this mailbox and then asked to "
                  + "organize it again while the first request was still being carried out; the "
                  + "later press stands, nothing is recorded as released, and the next poll "
                  + "organizes this mailbox here again",
              });
              return false;
            }
            holderSeen.kind = null; holderSeen.name = null;
            holderSeen.since = null; holderSeen.state = null;
            holderSeen.capabilities = null;
            // The window the statement opened owes the pass a run, whatever the next look reads.
            scope.gapOwed.add(mb.id);
            /* THE REQUEST IS SPENT, and this is the only line that spends it: the statement above
               is what cleared the row's own column, so the projection moves with it and not a
               moment earlier. The catch below does NOT clear it — a write that failed leaves the
               request standing, which is what its own sentence says. */
            releaseStamp = null;
          } catch (err) {
            scope.log("organizer_release_write_failed", {
              err,
              reason: "this install has stopped organizing the mailbox and its claim is gone; the "
                + "row could not record it, so the next poll honours the request again",
            });
          }
          box.takeoverAuthorized = false;
          box.observedTakeoverAt = null;
          /* On the lapse path this pass read nothing from the folder — the enumeration is what
             failed — so a standing unreadable mark is carried, on the unconfirmed arm's own rule:
             a pass that learned nothing may not clear an outage. A confirmed release DID read the
             folder, and clears it as it always has. */
          box.organizer = {
            organizing: false, reason: null, heldBy: null,
            unreadableSince: releasedByLapse ? box.organizer.unreadableSince : null,
            unreadableReason: releasedByLapse ? box.organizer.unreadableReason : null,
            releaseRequestedAt: releaseStamp,
            /* THE CLAIM IS GONE — confirmed out of the folder, or lapsed past believability. */
            claimed: false,
            /* Cleared with the request, in the statement that recorded the release. */
            releaseRefusal: null,
            holderState: null,
            ...(settingsLeft === undefined ? {} : { settingsLeft }),
          };
          /* NOT `priorStandDown`. That memory answers "somebody else holds this", and it is what
             `standDownMemory` derives from the row — which now reports a released mailbox as no
             memory at all. Setting it here would make the pane say another organizer had taken the
             mailbox from an install whose owner simply stopped it. */
          // The RELEASE's sentence: nobody took this mailbox, so "schedule it again where the
          // mailbox is organized now" would name a place that does not exist.
          await box.standDownAppointments("organized_elsewhere:unknown", RELEASED_ORGANIZER_SEND_SENTENCE);
          if (releasedByLapse) {
            scope.log("organizer_released_by_lapse", {
              mailboxId: mb.id,
              reason: "this install was asked to stop organizing this mailbox and the server never "
                + "confirmed its record was removed; the record has now been stale for longer than "
                + "any install honours one, so the organizing here is recorded as ended — the claim "
                + "ages out of the folder on its own, and this install reads from now on",
            });
          } else {
            scope.log("organizer_released", {
              reason: "the person stopped organizing this mailbox here; this install keeps its login, "
                + "its poll timer, its credentials and its mirror, and reads the mailbox from now on",
            });
          }
          return false;
        }

        /* A reader with no press never enters the gate — and it looks. This replaces
         * `if (priorStandDown && !takeoverAuthorized) return false;`, changing where the answer
         * comes from (the row, not RAM) and what happens on the way out: the old arm returned
         * without peeking, so a demoted desktop's holder columns froze at the handover and a
         * second handover was invisible. `notePeekedHolder` is the APPEND-less read — one
         * method, no way to write — so the reader learns who holds the mailbox every poll and
         * still cannot claim it. A live press outranks the role: the press is the explicit
         * human action this arm waits for, and the stamp is re-read above precisely so a press
         * that landed after assembly is seen.
         */
        /* Handed back — and the refusal is ahead of the lease read. `runLeaseGate` does not
         * merely report: on an empty `ohmail/_meta` it APPENDS this install's claim, so asking
         * it at all is already taking the mailbox — a check placed after it would re-claim the
         * very mailbox this install just gave back (measured as a poll landing behind a
         * hand-back). Above the reader arm because it is not about roles: the row still says
         * organizer and is meant to, so `resume()` can promote with no press.
         * `notePeekedHolder` is skipped too — a phone about to be suspended has no pane to feed.
         */
        if (box.handedBack) {
          box.organizer = { ...box.organizer, organizing: false };
          return false;
        }
        /* …and THIS install's own consented tenure, lapsed with nobody's Stop on it, is not a reader
           waiting for a press: the gate runs with no takeover, and rule 3 decides. */
        if (!rowRead || (rowRole === "reader" && !box.takeoverAuthorized && !resumesOwn)) {
          if (!rowRead) {
            scope.log("organizer_row_unreadable", {
              reason: "this pass could not read the row that says whether this install organizes "
                + "this mailbox, so it looks at the lease and claims nothing — an unreadable row "
                + "is not permission, and the next poll asks again",
            });
          }
          await notePeekedHolder(box.priorStandDown as MailboxDisabledReason | null);
          /* The answer and the cache agree, even when both reads failed. `notePeekedHolder`
           * carries the previous record on its catch — correctly, a failed look is not
           * evidence — but this arm is also reached when the ROW read failed, and then nothing
           * had set `organizing`: it kept the last good answer, `true`, while this function
           * returned false — and `drain` decides organizer-only work from that field, so the
           * pass that could not establish its role ran as the organizer. The pass is not
           * organizing, so the field says so; `unreadableSince` is what tells a person the
           * difference between "nothing organizes this" and "we could not look". */
          /* AND NOT OURS. A row that says reader is an instruction, and a row that could not be
             read is not permission — neither may leave a stale `claimed` standing for the phone's
             background arm to start a notification on. */
          box.organizer = { ...box.organizer, organizing: false, claimed: false };
          /* And cache the organizer's settings document, once per reader cycle (mail 0094). A
           * reader's own responder/rule/window/signature rows are inert: the ones in force are
           * in the published document of the install that HOLDS this mailbox — the panes used
           * to render the local rows anyway, and the reader now keeps a copy that
           * `GET /mailboxes/:id/profile` serves. Only on the reader arm, and only when the row
           * actually says `reader`: unlike the bounded peek this read fetches full message
           * sources, a cost with nothing behind it on a mailbox whose role is unknown; the
           * pre-consent arm is excluded because nobody agreed to that mailbox. Never throws —
           * `syncProfileMirror` owns that: one poll stale beats an invented absence. */
          if (rowRole === "reader") {
            /* PROBED, not asserted — `notePeekedHolder`'s exact shape for `leasePeekIo`. `profileIo`
               is not on `MailboxAdapter`: it is an accessor the real IMAP adapter carries and a test
               double need not, so an adapter without it is SKIPPED rather than crashing a sync
               cycle over a cache. */
            const mkIo = (box.adapter as Partial<{
              profileIo(id: { installId: string; mailboxId: string }): ProfileIo;
            }>).profileIo;
            if (typeof mkIo === "function") {
              await syncProfileMirror({
                db: scope.db, accountId: scope.world.accountId, mailboxId: mb.id,
                /* A NAMED READER IDENTITY, not this install's own. `readOrganizerProfile` remembers
                   a position per identity, and borrowing the organizer write-behind's would let a
                   read and a write share one anchor — the API's profile reader makes the same split
                   for the same reason. */
                io: mkIo.call(box.adapter, { installId: "reader-profile-mirror", mailboxId: mb.id }),
                now: scope.now(), log: scope.log,
              });
            }
          }
          return false;
        }
        /* Nobody has agreed to this yet, so this install reads and arranges nothing. AHEAD of
         * the lease read — the ordering is the whole guard: `runLeaseGate` APPENDS a claim on
         * an empty folder, so asking it is already taking the mailbox. Measured without this: a
         * person typed a password and six seconds later their backlog had been moved into six
         * new folders, the consent screen reachable only afterwards. `!takeoverAuthorized` is
         * what makes the flow work rather than deadlock: the consent route writes
         * `organize_consented_at` and `takeover_authorized_at` in ONE transaction, so the first
         * pass after "Agree" promotes. `organizer` IS set here (`drain` gates organizer-only
         * work on it); `reason` is NULL — no holder to name; `priorStandDown` is NOT set. */
        if (!box.consented && !box.takeoverAuthorized) {
          box.organizer = { organizing: false, reason: null, heldBy: null, unreadableSince: null, unreadableReason: null,
            releaseRequestedAt: releaseStamp, claimed: false,
            releaseRefusal: box.organizer.releaseRefusal, holderState: box.organizer.holderState };
          await notePeekedHolder(null);
          return false;
        }
        /* What this claim offers a reader (mail 0090): `requests`, but only where a shared
         * secret exists to verify one with. The key is HKDF over the MAILBOX PASSWORD — the one
         * secret this install and the hosted worker both hold, and one that whoever can merely
         * APPEND to `ohmail/_meta` does not — derived from the credential this process already
         * opened IMAP with, never stored or fetched; deriving needs no network, so both
         * directions of the channel are available on equal terms with Cloud. `null` for an
         * OAuth mailbox: each install holds its own token, so there is no shared secret — the
         * claim advertises nothing and a reader is refused honestly at its own door.
         */
        /* ══ THE CLAIM IS OURS FROM HERE ═══════════════════════════════════════════════════
         *
         * Reaching this line means the row says organizer and somebody consented — the instruction
         * the claim below carries out. It is set HERE and not with `organizing` two awaits down
         * because the lease read APPENDS the claim to `ohmail/_meta` and the permit is a second
         * round trip: between them a caller reading `organizing` sees exactly what it sees for a
         * mailbox nobody has consented to, and the phone's background arm gave that reading back.
         * A pass that goes on to stand down or to yield clears it below.
         */
        box.organizer = { ...box.organizer, claimed: true };
        /* Captured once so the renewal memory records the SAME instant the gate writes into the
           claim's heartbeat — the lapse bound below compares against what a reader of the folder
           can actually see, not against a second clock reading taken after the round trip. */
        const gateAskedAt = scope.now();
        /* ASKED ONCE PER GATE, and compared against what this mailbox has acted on. A person who
           corrects a wrong clock without restarting is refused for ever without this: both stamps
           on the claim we wrote are immutable, so the record goes on measuring the old clock. */
        const correctionsNow = scope.clockCorrections();
        const leaseArgs = {
          adapter: box.adapter,
          mailboxId: mb.id,
          self: {
            installId: scope.installId, kind: scope.organizerKind, displayName: scope.machineName, lastNonce: box.leaseNonce,
            /* AND EVERY NONCE MINTED HERE: an install recognises its own claim whatever happened
               to the response. */
            mintedNonces: box.leaseMinted,
            ...(correctionsNow !== box.seenClockCorrections ? { clockCorrected: true } : {}),
          },
          hasRequestKey: box.requestKey !== null,
          // An explicit human choice, and the ONLY thing that distinguishes "this mailbox's last
          // organizer went quiet" from "the user wants this machine to have it". Without it the
          // lease reports such a mailbox as available and declines to take it, which is the right
          // default and the wrong answer once somebody has actually asked.
          //
          // THE INSTANT, and it is `observedTakeoverAt` rather than a fresh clock reading: the
          // stamp this pass actually read is the one it may act on, and it is the same value the
          // stand-down below compares against before voiding anything. A `now()` here would make
          // every press look like it happened at the moment of the gate — so a stale press that
          // ought to lose rule 6 would win it, on every cycle, for ever.

          // AND THE VERB, which lets rule 6 refuse a press that asked only to JOIN a mailbox
          // another install is organizing. Read in the same statement as the instant.
          takeover: box.takeoverAuthorized && box.observedTakeoverAt !== null
            ? { authorizedAt: box.observedTakeoverAt, intent: box.observedIntent }
            : null,
          ...(config.leaseStaleAfterMs !== undefined ? { staleAfterMs: config.leaseStaleAfterMs } : {}),
          log: scope.log,
        };
        /* THE GATE'S OWN MINT IS RECORDED TOO, before its append: unrecorded, a renewal that
           committed and lost its answer read as a copy of this install on the next pass. */
        const outcome = await readMailboxLease({ ...leaseArgs, now: gateAskedAt, onNonceMinted: box.noteMinted });
        box.holderLooked = true;
        box.gateContinued = outcome.organize && outcome.continued === true;
        /* SPENT BY THE GATE THAT READ IT, and only once it RETURNED: a cycle that threw on the
           network never offered the correction to the lease, and spending it there would lose the
           one renewal it licenses until the person set their clock again. */
        box.seenClockCorrections = correctionsNow;
        box.claimServerAt = outcome.organize ? outcome.claimServerAt ?? null : null;
        if (outcome.organize) {
          box.leaseNonce = outcome.nonce;
          /*
           * THE ROW FOLLOWS THE CLAIM, WITH NOTHING BETWEEN THEM. `readMailboxLease` has just said
           * ORGANIZE, so this install's claim stands in `ohmail/_meta` and is verified there. From that
           * instant to the row saying `organizer` nothing else may be awaited: measured here, the
           * promotion sat behind `acquireLeasePermit`'s `stampMeta`, an IMAP STATUS worth ~83 ms, and
           * for that window the folder advertised this install as organizer while its own row — the one
           * every write door consults — still said `reader`. The promotion is issued here and the permit
           * taken after it; the permit adopts this same read, and the folder reading it already took, so
           * a take-over landing in this gap cannot reach the permit's baseline.
           */
          // THE MEMORY IS SPENT WITH THE STAMP. Reaching here past a remembered stand-down means a
          // human pressed the button and the lease agreed; leaving the memory set would make the
          // very next poll return false for an install that IS the organizer — it would drain as a
          // reader against a row that says `organizer`, which is the two halves disagreeing in the
          // other direction. See {@link priorStandDown}.
          box.priorStandDown = null;
          if (box.takeoverAuthorized || resumesOwn) {
            // Spend it — one becoming, not a standing right: leaving the stamp set would let
            // this install seize the mailbox back on a later launch after a human moved it
            // elsewhere. The stand-down is cleared in the same statement, here and nowhere
            // earlier: this is the moment `readMailboxLease` said ORGANIZE — a clear at
            // assembly would publish a `connected` mailbox to the send/schedule paths before
            // any lease read. `disabled_reason` is re-checked in SQL, not memory: a
            // `DELETE /mailboxes/:id` committing during the lease's round trip makes the row a
            // tombstone, and an unconditional write would revive it; the stamp is spent either
            // way. The write's read-back decides whether this launch organizes at all: finding
            // the tombstone, it organizes nothing and the appended claim ages out.
            const spentStamp = box.observedTakeoverAt;
            try {
              const [after] = await scope.db.transaction(async (tx) => {
                const rows = await tx.update(mailboxes)
                .set({
                  status: sql`case when ${mailboxes.disabledReason} is not null then 'connected' else ${mailboxes.status} end`,
                  disabledReason: null,
                  takeoverAuthorizedAt: null,
                  /* The role, in the same statement as the stamp it spends. Without this the
                   * row still says `reader` for an install the lease just made the ORGANIZER,
                   * and `organizer_role` is the authority every write door consults: the
                   * install would move mail on IMAP while its own API refused every request
                   * with `409 organized_elsewhere`, naming itself. Unreachable before — until
                   * the stamp could be spent by a POLL, every promotion went through a relaunch
                   * where the role is written at assembly; arming the reader's loop made this
                   * path live, so it is repaired here.
                   */
                  organizerRole: "organizer",
                  // Mail 0088 — a mailbox organized here again is not a released one. The marker
                  // describes the CURRENT state, so the promotion ends it.
                  organizerReleasedAt: null,
                  /* And the holder columns go with the role (0.14.1). This block used to leave
                   * them for "the next cycle's own writes" — false for this shape:
                   * `notePeekedHolder` is the only later writer and it runs on the READER arm,
                   * which an organizer never reaches, so the stale holder stood until something
                   * demoted the install again. The hosted twin has cleared them in this same
                   * statement since mail 0083, for the governing reason: a row that says
                   * `organizer` while still naming who organizes it is a banner that contradicts
                   * itself — and once the notice landed, an organizer row naming a previous
                   * holder rendered "another install organizes this mailbox now" about itself.
                   */
                  organizedByKind: null,
                  // Mail 0092 — the sixth goes with the other five. A holder cleared in five
                  // columns and remembered in a sixth is the migrated row all over again.
                  organizedByInstallId: null,
                  organizedByName: null,
                  organizedSince: null,
                  organizerState: null,
                  // Mail 0089 — the fifth holder column goes with the other four, for the same
                  // reason: this row is now the organizer and names no holder at all.
                  organizedByCapabilities: null,
                  /* Mail 0088: the fourth writer of the (role, state, holder) triple, in the
                   * SAME statement as the role — another door reads `elsewhere` off it. Stamped
                   * only on a FLIP, the hosted twin's rule (`clearOrganizerStandDown`): a row
                   * already `organizer` keeps its instant, or a press standing past an earlier
                   * promotion re-raises a notice the person dismissed. The SET reads the
                   * PRE-update role.
                   */
                  organizerEventAt: sql`case when ${mailboxes.organizerRole} = 'reader'
                    then ${dialect(scope.db).ts(scope.now())} else ${mailboxes.organizerEventAt} end`,
                  // Mail 0169 — a new tenure: no drain of it has finished yet.
                  organizedThrough: null,
                  // Mail 0169 — a promotion over a holder ends the held stretch the row recorded.
                  heldElsewhereUntil: heldElsewhereUntilOnLeave(dialect(scope.db)),
                })
                .where(eq(mailboxes.id, mb.id))
                .returning({ status: mailboxes.status });
                // The local rules are this mailbox's configuration now: the entity drains as a tombstone.
                if (rows.length > 0) await recordMailboxProfileChange(tx as unknown as LedgerTx, scope.world.accountId, mb.id);
                return rows;
              });
              box.takeoverAuthorized = false;
              if (!after || after.status === "disabled") {
                scope.log("organizer_takeover_row_removed", {
                  reason: "this mailbox was removed while the organizer lease was being read, so " +
                    "this install organizes nothing and serves the mirror it already has; the " +
                    "claim it appended ages out of the mailbox on its own",
                });
                box.organizer = { organizing: false, reason: null, heldBy: null, unreadableSince: null, unreadableReason: null,
                  /* The mailbox is gone; the claim this pass appended ages out of a folder nothing
                     will serve, so nothing may be started on the strength of it. */
                  releaseRequestedAt: releaseStamp, claimed: false,
                  releaseRefusal: null, holderState: null };
                box.stopped = true;
                if (box.timer) clearTimeout(box.timer);
                if (box.heartbeatTimer) clearTimeout(box.heartbeatTimer);
                try {
                  await box.adapter.close();
                } catch (closeErr) {
                  scope.log("adapter_close_failed", { err: closeErr });
                }
                return false;
              }
              /*
               * THE PROMOTION SAYS SO, AND IT SAYS SO HERE — ahead of `acquireLeasePermit` below.
               *
               * The failure half has had a line since it existed; without this one the ORDER that
               * paragraph above is about could only be read off a test fixture, and the fixture the
               * guard used measured the permit's `stampMeta` invocation, which the baseline move put
               * ahead of the row on purpose. Two product lines — this one and `lease_permit_granted`
               * — are the order itself. `state` and a constant sentence rather than `from`/`to`:
               * those two are address-shaped names this repository's logger does not admit.
               */
              scope.log("organizer_row_promoted", {
                mailboxId: mb.id,
                state: "organizer",
                reason: "the lease said organize and this install's claim stands in the folder, so " +
                  "the row moved from reader to organizer before the permit was taken",
              });
              if (resumesOwn) {
                scope.log("organizer_own_claim_resumed", {
                  mailboxId: mb.id,
                  state: "organizer",
                  reason: "this install's own claim had lapsed with nobody else holding the mailbox and " +
                    "nobody having stopped it, so it organizes the mailbox again with no press",
                });
              }
              // The next organizing drain asks whether this was a person's first agree.
              box.agreeSweep = spentStamp === null ? null : { stamp: spentStamp, cursor: null };
            } catch (err) {
              /* THE ROLE WENT WITH THE STAMP, so this is not "one more spendable cycle": the write
               * that failed is the one that makes the row say `organizer`, and without it this
               * install holds the claim while its row still says `reader` — the state the statement
               * above exists to prevent, reported rather than left lying. `takeoverAuthorized` is
               * deliberately NOT cleared here (the clear is inside the try, after the write
               * resolved), so the stamp is still on the row and the next cycle promotes again. */
              scope.log("organizer_promotion_failed", {
                err,
                mailboxId: mb.id,
                reason: "this install holds the organizer claim and its row could not be promoted, " +
                  "so the row still says reader; the authorization stays on the row and the next " +
                  "cycle writes it again",
              });
            }
          }
          // THE READ ABOVE IS THE PERMIT'S FIRST LOOK, adopted rather than repeated: the gate
          // renews this install's claim, so a second run here is the same-millisecond
          // self-stand-down `MIN_PERMIT_TTL_MS` refuses.
          // No TTL knob: one value for the fleet (`DEFAULT_PERMIT_TTL_MS`). A configurable window
          // beside a fixed believability cutoff is silently the smaller of the two.
          box.leasePermit = await acquireLeasePermit({
            ...leaseArgs, adopt: { outcome, at: gateAskedAt }, now: scope.now,
            /* The ring as it stands now, the gate's own mint included. */
            self: { ...leaseArgs.self, mintedNonces: box.leaseMinted },
            monotonic: scope.monotonic,
            /* ── A RENEWAL THIS INSTALL PERFORMED IS THIS INSTALL'S CLAIM ─────────────────
             *
             * The permit re-reads past its deadline or its write count, and a re-read RENEWS:
             * new nonce in the folder, the old copy expunged. Held here, the old nonce made the
             * next gate read our own claim as a restored clone — this install stood ITSELF down
             * and left a live claim nobody was behind, refusing the next install for a staleness
             * window — and made `releaseOwnClaim` address a claim that no longer exists, so
             * "stop organizing here" released nothing. One writer owns the settled nonce.
             */
            onRenew: ({ nonce: renewed, at }) => {
              box.leaseNonce = renewed; box.lastLeaseRenewalAt = at;
            },
            /* AND WHAT THE PERMIT MINTED, before the append that carries it — a renewal inside the
               permit whose answer is lost still leaves this install able to name what it wrote. */
            onNonceMinted: box.noteMinted,
          });
          // The gate renewed this install's claim with `gateAskedAt` as its heartbeat — the fact
          // the release's lapse bound reads. See `lastLeaseRenewalAt`.
          box.lastLeaseRenewalAt = gateAskedAt;
          // Reading the lease is what proves it: a resolved gate clears the unreadable mark.
          box.organizer = { organizing: true, reason: null, heldBy: null, unreadableSince: null, unreadableReason: null,
            releaseRequestedAt: releaseStamp, claimed: true, releaseRefusal: null, holderState: null };
          return true;
        }

        box.organizer = {
          organizing: false,
          reason: outcome.reason,
          heldBy: outcome.by?.displayName ?? null,
          /* DISPLACED. Another install holds the mailbox, so the claim is not ours to defend and
             not ours to give back. */
          claimed: false,
          // The lease WAS read to reach a stand-down, so whatever was unreadable no longer is.
          unreadableSince: null, unreadableReason: null,
          releaseRequestedAt: releaseStamp,
          releaseRefusal: null,
          /* The gate read the claim it stood down behind: live, or offered past its window. */
          holderState: outcome.state,
        };
        // Standing down voids any unspent authorization, in memory and on the row below. We are not
        // the organizer, so becoming one again is a new becoming and needs a new explicit request.
        box.takeoverAuthorized = false;
        scope.log("organizer_stand_down", {
          /* THE MAILBOX THIS VERDICT IS ABOUT. A stand-down is a per-mailbox decision and this
             line named none, so on an install holding more than one mailbox the log could not say
             which one had changed hands — an incident nobody can read off the record it leaves.
             The id and never the address: this is a log. */
          mailboxId: mb.id,
          disabledReason: outcome.reason,
          heldBy: box.organizer.heldBy,
          // `state` and NOT `organizerState`, which is the name this line shipped with and which
          // `ALLOWED_FIELDS` drops — so the stand-down line reported `droppedFields` and said
          // nothing about the state it exists to name. `reconcile-cron.ts:259` already carries the
          // same correction in the same words for the same value on the hosted door.
          state: outcome.state,
          // HOW THE HOLDER RELATES TO THIS INSTALL — see {@link ownClaimTerm}. Anything but
          // `install_id` on this line is an install standing down from a claim of its own.
          ownClaimTerm: ownClaimTerm(outcome.by, scope.installId, box.leaseNonce, box.leaseMinted),
          reason: "another organizer holds this mailbox; this install becomes a READER of it — it " +
            "keeps its login and its poll timer, its mirror goes on growing, it can mark mail read " +
            "and send, and it moves, files and deletes nothing",
        });
        /* The handover rides the demotion's transaction, and the latch rides its success.
         * Three separate statements left two sequences open: a paired device's forwarded move
         * committing after the handover read its pending set and before the demotion —
         * accepted, then neither performed nor exported; and a swallowed handover failure with
         * the latch set anyway — the transition gate skipping the handover for ever. One
         * transaction, latch only on commit: `exportPendingMovesOnStandDown` takes `FOR UPDATE`
         * on the row first, `assertOrganizerRole` takes `FOR SHARE` inside the transaction
         * recording a forwarded move — no admitted intent missed, none admitted afterwards. On
         * the transition only: an ungated export would mint a request per poll.
         */
        const wasOrganizing = box.priorStandDown === null;
        try {
          /* The role, not the status. Writing `status: "disabled"` stopped the install: timer
           * cleared, login closed, mirror frozen at the handover — the earlier dual-mode design,
           * replaced by the 2026-09-01 owner ruling (the doc is amended in the same commit). A
           * demoted install is a READER: `connected`, on its own roster, the four holder columns
           * written from the SAME verdict that demoted it, so the row names who holds the
           * mailbox without any client dialling IMAP. `disabled_reason` is deliberately not
           * written any more: `disabled` means tombstone or plan-disable, full stop, and a
           * reader carrying a stand-down reason would be a row saying two things about itself.
           */
          const sdKind = organizerKindColumn(outcome.by?.kind ?? outcome.reason.split(":")[1]);
          const sdName = organizerDisplayName(outcome.by?.displayName ?? null);
          const handed = await scope.db.transaction(async (tx) => {
            const exported = wasOrganizing
              ? await exportPendingMovesOnStandDown(tx as unknown as Tx, {
                accountId: scope.world.accountId, mailboxId: mb.id, now: scope.now(), mintId: randomUUID,
              })
              : null;
            await tx.update(mailboxes)
            .set({
              organizerRole: "reader",
              // Mail 0088 — BEING BEATEN IS NOT RELEASING. A row carrying both would report the
              // quieter of the two events to a person whose mailbox somebody else has just taken.
              organizerReleasedAt: null,
              /* THROUGH THE WRITE DOOR, because the middle term is a word cut out of a reason
                 string and this store has no CHECK to catch it: `organized_by_kind` is widenable,
                 so the device's refusal is `organizerKindColumn` and nothing else. An unrankable
                 peer becomes `unknown`, which every reader downstream fails closed on. */
              organizedByKind: sdKind,
              /* Mail 0092 — AND DELIBERATELY NO INSTALL ID HERE. The kind above falls back to a word cut
                 out of a reason string; an identity manufactured that way, in a column a release decision
                 is made on, would satisfy the compare and never refresh — a fabrication that outranks the
                 NULL it replaced. The verdict carries no id for the winner, so the column stays NULL, and
                 NULL fails closed, which is the safe direction. Do not "complete" this by deriving one. */
              // Header-safe and capped at the write — this is another install's machine name,
              // arriving out of an RFC822 header it wrote.
              organizedByName: sdName,
              organizedSince: outcome.by?.claimedAt ?? null,
              organizerState: outcome.state,
              // Mail 0089 — the fifth holder column, from the SAME verdict.
              organizedByCapabilities: capabilitiesColumn(outcome.by?.capabilities ?? null),
              /* THE STAMP THIS PASS READ, and only that one — see {@link observedTakeoverAt}. A
                 press that landed while the lease was being read was never offered to it, and
                 clearing it here would answer a request nothing ever considered. `IS NOT DISTINCT
                 FROM` rather than `=` so the ordinary case (both NULL) matches: SQL equality on two
                 NULLs is NULL, which would make this a no-op on every stand-down that had no stamp
                 and leave the column's own value untouched — harmless there, and the wrong shape to
                 rely on. The column is compared at the reading's precision (`truncMs`): the store
                 keeps microseconds, the pass read a millisecond `Date`, and an exact compare never
                 spent a stamp the store's clock wrote. Same rule as the two compare-and-sets above. */
              takeoverAuthorizedAt: sql`case when ${dialect(scope.db).truncMs(mailboxes.takeoverAuthorizedAt)} is not distinct from ${dialect(scope.db).tsOrNull(box.observedTakeoverAt)}
                then null else ${mailboxes.takeoverAuthorizedAt} end`,
              // Mail 0088 — the demotion half, and the fifth writer of the triple. Stamped in the
              // same statement as the role and the holder columns it is announcing.
              // …ONLY ON A CHANGE of (role, holder, state), the hosted twin's rule: a row already a
              // reader of this holder in this state keeps its instant, or a dismissed notice returns.
              organizerEventAt: sql`case when ${mailboxes.organizerRole} = 'reader'
                and ${mailboxes.organizedByKind} is not distinct from ${sdKind}
                and ${mailboxes.organizedByName} is not distinct from ${sdName}
                and ${mailboxes.organizerState} is not distinct from ${outcome.state ?? null}
                then ${mailboxes.organizerEventAt} else ${dialect(scope.db).ts(scope.now())} end`,
              gapSince: null, gapLetters: null, gapPressedAt: null, gapStrangers: null,
              organizedThrough: null,
              // Mail 0169 — a verdict that is not `held` ends a held stretch the row recorded.
              ...(outcome.state === "held" ? {} : { heldElsewhereUntil: heldElsewhereUntilOnLeave(dialect(scope.db)) }),
            })
            .where(eq(mailboxes.id, mb.id));
            // The gap columns: another install's claim won, a held look, so the window closes.
            // A reader now: a surface presents this mailbox by the organizer's cached document.
            await recordMailboxProfileChange(tx as unknown as LedgerTx, scope.world.accountId, mb.id);
            return exported;
          });
          /* THE LATCH, AFTER THE COMMIT. A reader keeps polling, so without it the next cycle
             would ask the lease again and take the mailbox back the moment the other organizer
             released it — and setting it before the write meant a failed write silently retired
             the handover with it. See {@link priorStandDown}. */
          box.priorStandDown = outcome.reason;
          if (handed !== null && (handed.exported > 0 || handed.unmappable > 0)) {
            scope.log("organizer_stand_down_moves_handed_over", {
              mailboxId: mb.id,
              exported: handed.exported, already: handed.already, unmappable: handed.unmappable,
              reason: "these moves were recorded here before the lease was read again; each is now "
                + "a request for the install that holds the mailbox. `unmappable` are intents this "
                + "handover cannot express — a desired folder no destination word covers, or a "
                + "message with no usable dedup key — and they stay pending exactly where they are",
            });
          }
        } catch (err) {
          scope.log("organizer_stand_down_write_failed", {
            mailboxId: mb.id,
            err,
            reason: "neither the demotion nor the handover of pending local moves was recorded, so "
              + "the row still says this install organizes the mailbox; this install reads it "
              + "regardless and the next cycle demotes and hands over again",
          });
        }
        // And the appointments this install can no longer keep are closed, here.
        // `sendScheduled()` is inside `drain`, and `drain` is behind this gate — from the line
        // below, the scheduled-send pass never runs on this install again, so everything it
        // owed is owed now or never: the appointment does not travel (the portable profile
        // carries no drafts), and `SCHEDULED_SEND_EXPIRY_MS` is enforced inside that
        // unreachable pass. Without this call a pending scheduled send is never delivered,
        // never reported failed, and Drafts says "Sends Tue 14:50" for a time that has gone,
        // for ever (measured; see `closeStoodDownAppointments`). Not folded into the
        // stand-down UPDATE: different owners, different failure answers — a stand-down must
        // never be contingent on closing an appointment; a failed close is retried at launch.
        await box.standDownAppointments(outcome.reason);
        /* The timer and the login stay. The three statements that followed this line
         * (`stopped = true`, `clearTimeout`, `adapter.close()`) were the whole of "stops
         * syncing entirely"; they are gone from THIS path and kept for the two that still mean
         * it — a tombstone, and a removal discovered mid-launch. What replaces them is nothing:
         * `start()` continues and the next cycle is a READER cycle. The mirror keeps growing,
         * which is the product difference — a person who moved organizing to another machine
         * still reads, searches and sends from this one. `return false` still means "this
         * install is not the organizer"; it no longer means "and therefore do nothing".
         */
        return false;
      };
      box.profileSync = profileSync;
      box.peekOrganizer = peekOrganizer;
      box.lettingGo = lettingGo;
      box.settingsNotLeft = settingsNotLeft;
      box.mayOrganize = mayOrganize;
}
