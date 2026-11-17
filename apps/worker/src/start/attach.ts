import { sql, eq, and } from "drizzle-orm";
import {
  type OrganizerRole, mailboxes, type Tx, messages, folderState, junkSweepCandidateWhere,
} from "@trafficflow/db";
import { providerAuthservIds } from "@trafficflow/core";
import { storedFoldersOf, recordSpecialFolders } from "@trafficflow/core/adapters/drizzle-repo";
import { type MailboxAdapter, learnSmtpMaxSize, WORKER_NET_TIMEOUTS } from "@trafficflow/core/adapters/imap";
import { TURN_START_MESSAGES } from "../config.js";
import { type AttachTicket, AttachAbortedError, AttachDeadlineError } from "../attach-pool.js";
import { profileProducerVersion } from "../build-version.js";
import { type SyncDeps, UNLABELLED_BUILD } from "@ohmail/organizer/sync";
import { shrinkMetaOnRefusal } from "@ohmail/organizer/request-drain";
import {
  type SweepScanState, SWEEP_SCAN_START, sweepStateForPress, junkSweepPass, adoptSweepWindow,
} from "../junk-sweep.js";
import { DeadLetterLedger, isDatabaseFault } from "@ohmail/organizer/dead-letter";
import { KnownSetCache } from "@ohmail/organizer/known-set";
import { checkedDial } from "../dial-host-guard.js";
import { runKickstart } from "../kickstart.js";
import { makeSmtpSizeDial, recordSmtpMaxSize } from "../smtp-size.js";
import { type EnabledMailbox, loadMailboxCreds, makeSyncWriteFence } from "../mailboxes.js";
import { OrganizerProfileSync } from "@ohmail/organizer/profile";
import { type OrganizerWriteAuthority, writeDoorOf, LeaseUnavailableError, leaseBlockReason } from "@ohmail/organizer/lease";
import { deriveRequestKey } from "@trafficflow/core/adapters/organizer-lease";
import { type MailboxRuntime, JUNK_SWEEP_PER_CYCLE } from "../index.js";
import type { WorkerScope } from "./scope.js";

/** The worker's start function, one section: a mailbox attached and detached. */
export function attachSection(scope: WorkerScope): void {
    /** Unwatch + CLOSE a mailbox's connection and drop it from the rotation. */
    async function detach(rt: MailboxRuntime, reason: string): Promise<void> {
      // Only THIS runtime: a re-attach may already have put a new one in its place.
      if (scope.runtimes.get(rt.mailboxId) === rt) { scope.runtimes.delete(rt.mailboxId); scope.gapClearances.delete(rt.mailboxId); }
      // THE KNOWN-SET MEMO DIES WITH THE ATTACHMENT. Dropping the runtime already makes it
      // unreachable, so this is belt AND braces — but it is the braces that state the invariant:
      // an in-memory copy of a mailbox's known UIDs may never outlive this process's claim on that
      // mailbox, because the next organizer is free to write those very rows.
      rt.deps.knownSet?.drop(`detached: ${reason}`);
      if (rt.unwatch) { try { await rt.unwatch(); } catch { /* ignore */ } }
      try { await rt.adapter.close(); } catch { /* ignore */ }
      scope.log.info("mailbox_detached", { mailboxId: rt.mailboxId, accountId: rt.accountId, reason });
    }

    /**
     * Register one mailbox into the rotation: connect, prove the organizer lease, ensure the folder
     * tree, join `runtimes`, kickstart once, establish IDLE. It does NOT sync — the first drain and
     * restart convergence both ride `cycle()`, and the reason is measured: with two inline sync cycles
     * here, one production mailbox held this function for over six minutes and the next mailbox in the
     * roster was not dialled until it returned. EVERY failure path closes the adapter it just opened —
     * previously a throw from `ensureFolders()` or the inline drain leaked the connection, because the
     * adapter had not been pushed onto the tracked list yet.
     *
     * It runs in the attach pool, beside the queue, so it checks its `ticket` after every awaited
     * phase (a deadline or a stop ends it there) and joins `runtimes` LAST, once IDLE is up.
     */
    async function attach(mb: EnabledMailbox, ticket: AttachTicket): Promise<void> {
      // The setup is INSIDE the boundary. `loadMailboxCreds` and `makeAdapter` used to run ABOVE the
      // `try` below — a shard-wide outage waiting for one corrupt row. A credential envelope that
      // cannot be decrypted (bad ciphertext, a key version this deployment no longer carries), or an
      // `adapterFactory` that refuses one mailbox's configuration, threw from OUTSIDE every catch: on
      // a cold start it rejected `startWorkerWithLock` and released the lock; on a timer pass the
      // pass-level catch stopped, so later unattached mailboxes were never visited. The roster is
      // stable oldest-first, so the same bad row led every pass and healthy mailboxes behind it stayed
      // unsynced for ever. `adapter` is therefore nullable and the catch null-guards its close — every
      // per-mailbox failure now happens where that mailbox's own catch can see it.
      let adapter: MailboxAdapter | null = null;
      let unwatch: (() => Promise<void>) | null = null;
      try {
        const creds = await loadMailboxCreds(scope.db, mb.mailboxId, scope.keyProvider, scope.oauthTokenProvider);
        ticket.checkpoint();
        if (!creds) {
          // RECORD ONLY. The log below still announces once ever — that is a log-noise control and
          // it is correct — but it is no longer the ONLY record, which is what made this the most
          // silent of the three arms. `reconcileSyncBlocks` writes the row.
          scope.noteBlock(scope.awaitingCreds, mb.mailboxId, "awaiting_credentials");
          if (!scope.announced.creds.has(mb.mailboxId)) {
            scope.announced.creds.add(mb.mailboxId);
            scope.log.warn("mailbox_awaiting_credentials", {
              mailboxId: mb.mailboxId, accountId: mb.accountId,
              reason: "enabled but no 'imap' credential row — it cannot sync until credentials are provisioned",
            });
          }
          return;
        }
        scope.awaitingCreds.delete(mb.mailboxId);
        scope.announced.creds.delete(mb.mailboxId);

        // What this mailbox's submission server will accept (mail 0055). Attempted here because this
        // is a place that already holds decrypted SMTP credentials for a mailbox nobody is changing;
        // the rule and bounds are `learnSmtpMaxSize`'s, the timeouts and write `smtp-size.ts`'s. ON
        // THE MANAGED DEPLOYMENT THIS ALWAYS FAILS, measured: Railway blocks outbound submission
        // ports, so every dial answers "Connection timeout" while the IMAP dial to the same host on
        // 993 completes in the next log line — the managed service learns these numbers from the API
        // host instead. Kept because it is correct where egress is open (a self-hosted worker),
        // bounded to one refused connection per mailbox per process, logged at `info`. AWAITED rather
        // than fired-and-forgotten, so one mailbox's failure stays one mailbox's failure.
        try {
          const learned = await learnSmtpMaxSize({
            mailboxId: mb.mailboxId,
            announced: mb.smtpMaxSizeBytes,
            smtp: creds.smtp,
            attempted: scope.smtpSizeAttempted,
            // The same policy object the attach below dials under, threaded rather than re-read:
            // the probe and the connection must not disagree about one operator's network.
            dial: makeSmtpSizeDial(scope.dialHostGuard),
          });
          if (learned.outcome === "learned") {
            await recordSmtpMaxSize(scope.db, mb.mailboxId, learned.maxMessageBytes);
            scope.log.info("mailbox_smtp_size_learned", {
              mailboxId: mb.mailboxId, accountId: mb.accountId,
              announcedBytes: learned.maxMessageBytes,
            });
          } else if (learned.outcome === "failed") {
            // A submission server that refuses a login costs this mailbox its ceiling and nothing
            // else — the strict fallback still applies and the mailbox still syncs. `info`, not
            // `warn`: a mailbox whose SMTP password differs from its IMAP one is a supported
            // configuration this deployment simply cannot probe, not an incident.
            // A CLOSED CODE, never the submission server's own words: that text is written by a
            // third party, routinely contains the username, and `reason` is an allowlisted field.
            scope.log.info("mailbox_smtp_size_unlearned", {
              mailboxId: mb.mailboxId, accountId: mb.accountId, code: learned.code,
            });
          }
        } catch (err) {
          // The RECORD can still fail (a database fault), and it must not take the attach with it.
          // The RECORD failed (a database fault), not the dial. `code` from our own taxonomy
          // rather than the driver's message, on the same rule as the arm above.
          scope.log.info("mailbox_smtp_size_unlearned", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, code: "unknown",
          });
        }
        ticket.checkpoint();

        /**
         * THE DIAL'S OWN CHECK, at the moment of the dial: host, port and the address it pins. Under
         * the managed policy this resolves and clears now and the dial goes to what cleared; under the
         * self-host policy it clears nothing and the dial is by name, because a mail server on the
         * operator's own network is legitimate there. The organizer never sends, so the attach builds
         * NO submission leg: a sending server's host or port can never stop receiving. The SIZE dial
         * above asks its own check, and a send meets its refusal at the API's door.
         */
        /** The adapter an error was raised on, so `handleConnectionError` can route it. */
        const dialled: { adapter: MailboxAdapter | null } = { adapter: null };
        adapter = scope.makeAdapter({
          host: creds.imap.host, port: creds.imap.port, secure: creds.imap.secure,
          // The row's plaintext consent reaches the adapter only through the check, which admits
          // it at an address on the person's own network, pinned there.
          ...(await checkedDial(scope.dialHostGuard, creds.imap.host, creds.imap.port, "imap", creds.imap)),
          // The `auth` union already assembled by the shared builder: `{ user, pass }` for a
          // password mailbox, `{ user, fetchAccessToken }` for oauth2. Passed through untouched.
          auth: creds.imap.auth,
          sentDomain: scope.config.sentDomain,
          // What the last attach decided for Sent, Junk and Trash: a role never moves by a name guess.
          storedFolders: await storedFoldersOf(scope.repo, mb.mailboxId),
          // NOT the serverless defaults. This process holds its connections for the life of the
          // deployment and does bounded database work between IMAP commands; a 25 s socket
          // deadline chosen against Vercel's `maxDuration` is a deadline the worker's own cycle
          // can exceed legitimately. See `WORKER_NET_TIMEOUTS`.
          timeouts: WORKER_NET_TIMEOUTS,
        }, {
          accountId: mb.accountId, mailboxId: mb.mailboxId,
          onConnectionError: (err) => scope.handleConnectionError(mb.mailboxId, mb.accountId, err, dialled.adapter),
        });
        dialled.adapter = adapter;
        ticket.bind(adapter);
        // Said BEFORE the dial, because everything after it can still be slow: a hung provider,
        // a lease gate over four IMAP round-trips, a first `ensureFolders` against a real
        // server. Without this line an attach that never returns looks exactly like a worker
        // that never tried — which is precisely how a boot-time outage once read. It names the
        // mailbox, never the stored server.
        // `latencyMs`: how long this attach waited in the pool for a slot and its host.
        scope.log.info("mailbox_attach_started", {
          mailboxId: mb.mailboxId, accountId: mb.accountId, latencyMs: scope.attachPool.queuedMs(mb.mailboxId),
        });

        // ── EVERY PHASE IS TIMED, BECAUSE "WHICH PHASE DOMINATES" WAS UNANSWERABLE ─────────
        //
        // The production measurement could say only that `attach_started → attached` was
        // minutes for one mailbox and seconds for another. Nothing in the log said which phase, so
        // the diagnosis had to be argued from row counts in a retroactive query. These fields
        // ride on `mailbox_attached` so the NEXT boot answers it from production directly.
        //
        // There is deliberately no `restartMs`: the phase it would have measured is the pair of
        // inline sync cycles, and that is gone from this path entirely. A field reporting 0 for
        // a phase that no longer exists is worse than its absence — it reads as a fast drain.
        const tAttach = Date.now();
        // Raced, so a deadline or a stop settles the attach even if the dial ignores the close.
        await ticket.abortable(adapter.connect());
        ticket.checkpoint();
        const connectMs = Date.now() - tAttach;

        // The organizer lease, before the first move. Here and not below `ensureFolders()`: every line
        // after this WRITES to somebody's mailbox (`ensureFolders` creates the `ohmail/*` tree,
        // `runKickstart` re-routes the Screener backlog). If another organizer holds it, neither may
        // happen — "learn then act" is the rule for this seam, because reconnect-after-sleep is when a
        // mailbox most likely changed hands. Taking the first DRAIN off this path did NOT move this
        // gate, and the ordering is guarded (`ensure_folders` may not precede `lease_organize` —
        // `attach-nonblocking.e2e.test.ts`, claim 5). Standing down here returns EARLY and leaves the
        // mailbox out of `runtimes` (not a failure, so no retry backoff; the row is `disabled`, so the
        // next pass does not offer it). The nonce this gate writes is carried onto the runtime — it is
        // the clone defence's memory, and a discarded nonce re-arms that defence every cycle.
        const leaseState = {
          leaseNonce: null as string | null,
          leaseMintedNonces: [] as readonly string[],
          /* SEEDED AT THE CURRENT COUNT: this mailbox has no record of its own yet, so its first
             gate runs the launch arm and a difference here would be an admission nobody earned. */
          seenClockCorrections: scope.clockCorrections(),
          // Until the gate runs there is no permit; the attach's own gate call replaces this.
          leasePermit: { noLease: "not_supplied" } as OrganizerWriteAuthority,
          agreeStamp: null as Date | null,
        };
        const leaseRow = {
          takeoverAuthorizedAt: mb.takeoverAuthorizedAt, takeoverIntent: mb.takeoverIntent,
          disabledReason: mb.disabledReason,
          // Mail 0083 — see `MailboxRuntime.lease.organizerRole`. This is the shape the promotion
          // hole was reachable through: an existing reader row attaches with no stamp and a null
          // reason, so without this the gate had nothing left to notice it by.
          organizerRole: mb.organizerRole,
          organizeConsentedAt: mb.organizeConsentedAt,
          // Mail 0088 — the release request, read at attach for the same reason the stamp above
          // it is: a press that landed while this process was down is still owed an answer, and
          // the first gate after a restart is where it gets one.
          releaseRequestedAt: mb.releaseRequestedAt,
          organizerReleasedAt: mb.organizerReleasedAt,
        };
        /** What the row says the holder is, so the reader peek writes only on a CHANGE. */
        const holderSeen = {
          kind: mb.organizedByKind, name: mb.organizedByName,
          since: mb.organizedSince, state: mb.organizerState,
          capabilities: mb.organizedByCapabilities,
          installId: mb.organizedByInstallId,
        };
        const tLease = Date.now();
        /* A stand-down no longer ends the attach. This block used to `return`, and the mailbox left
         * the roster with its connection closed — standing down meant stopping. It now means BEING A
         * READER (another mail client on the mailbox), so the attach continues with `role: "reader"`,
         * keeps its login and poll timer, and builds a mirror that GROWS; what it does not do is the
         * four things below that write to somebody else's mailbox. `mayOrganize` has already written
         * the demotion, the holder columns and the appointment close, exactly as before. TWO REFUSALS
         * ARE FOLDED INTO ONE ANSWER: `mayOrganize` returns false both for "somebody else holds this"
         * and "nobody asked this install to organize it" (a consent-less mailbox), and the attach
         * treats them identically because the BEHAVIOUR is (read, do not move); the row tells them apart.
         */
        const role: OrganizerRole =
          (await scope.mayOrganize(mb, leaseRow, holderSeen, leaseState, adapter, "attach",
            deriveRequestKey({ auth: creds.imap.auth, address: mb.address }))) ? "organizer" : "reader";
        ticket.checkpoint();
        const leaseMs = Date.now() - tLease;
        if (role === "organizer") {
          scope.leaseBlocked.delete(mb.mailboxId);
        } else {
          // `reason: null` — the ROLE now carries the whole answer to "why is this mailbox not
          // being organized here", and it is a better answer than any sync-block member. See
          // `SyncBlock`.
          scope.noteBlock(scope.leaseBlocked, mb.mailboxId, null);
          // The row's holder columns, refreshed from the same connection that just looked. On the
          // stand-down path `markMailboxStoodDown` has already written them from the verdict's own
          // claim; this covers the OTHER arm — a consent-less reader, whose refusal never read the
          // folder at all, so without this its banner would have nothing to say.
          await scope.refreshReaderHolder(mb, adapter, holderSeen);
          ticket.checkpoint();
        }
        const tFolders = Date.now();
        /* -- `ohmail/*` IS CREATED BY AN ORGANIZER AND BY NOTHING ELSE ------------------------
         *
         * The first of the four skips, and the one the two-worlds test asserts against the SERVER
         * rather than against a log line: after N reader cycles over unruled INBOX mail, `ohmail/*`
         * is ABSENT on the mail server and every message is still in INBOX. A reader that created
         * the tree would be visibly organizing a mailbox it does not hold — in every other mail
         * client the person owns, and in the folder list of whoever does hold it.
         */
        if (role === "organizer") await adapter.ensureFolders(writeDoorOf({ lease: leaseState.leasePermit }));
        ticket.checkpoint();
        const foldersMs = Date.now() - tFolders;
        // ── Mail 0065: DISCOVER THE PROVIDER'S OWN \Junk AND \Trash, AND WRITE THEM DOWN ──
        //
        // Read-only (one LIST) and re-written on EVERY attach, so a folder the user creates or
        // renames heals on the next connect with no operator action. The columns are what lets
        // the API refuse a delete up front (`no_trash_folder`) and the reconciler file a spam
        // verdict into native Junk without a LIST per pending row — the API may never open
        // IMAP. Best-effort: a discovery failure leaves the stored answer as it was, and the
        // fallbacks (Quarantine / refusal) are never destructive. See imap-types.ts for the
        // product rule this serves.
        // Mail 0132: the Sent path the scan watches is written beside them (`recordSpecialFolders`).
        try {
          await recordSpecialFolders(adapter, scope.repo, mb.mailboxId);
        } catch (err) {
          scope.log.warn("special_folder_discovery_failed", { mailboxId: mb.mailboxId, err });
        }
        ticket.checkpoint();
        // accountId comes from the MAILBOX ROW, not from config: one process, many accounts.
        // The spend gate is built from that same accountId for exactly that reason.
        // The narrowed handle the sweep port's closures capture — `adapter` is a `let` above,
        // and TypeScript does not carry a `let`'s narrowing into a callback that runs later.
        const attachedAdapter: MailboxAdapter = adapter;
        /** The sweep's scan state for THIS attachment — see the `junkSweep.run` note below. */
        let sweepScan: SweepScanState = SWEEP_SCAN_START;
        const deps: Omit<SyncDeps, "writeAuthority"> = {
          repo: scope.repo, adapter, accountId: mb.accountId, mailboxId: mb.mailboxId,
          // Mail 0083. THE ATTACH-TIME ROLE, and it is the field's floor rather than its whole
          // story: `cycle()` re-verifies the lease before every pass and spreads `role: rt.role`
          // over these deps, so a flip in either direction applies on the very next cycle without
          // a re-attach. It is required here so this composition cannot be the one that forgets.
          role,
          // The leader fence over this mailbox's mail-bearing writes. The SAME `fence` the lifecycle
          // writes key on — one definition of "am I still the leader of this shard" — extended to
          // everything `runSyncCycle` persists and to its IMAP mutations. Before this line, a worker
          // whose advisory lock had dropped kept committing messages, advancing cursors, appending
          // change_log rows and issuing IMAP moves beside the new leader: the fence covered
          // `mailboxes.status` and nothing that carries mail. `() => lockLost` is the synchronous
          // tripwire — `handleLockLoss` flips it the moment loss is observed, so the in-flight cycle
          // refuses its NEXT write and unwinds. `stopped` is deliberately NOT part of it: a graceful
          // shutdown lets in-flight writes complete.
          fence: makeSyncWriteFence(scope.db, mb.mailboxId, scope.fence, () => scope.lockLost),
          ...(scope.spend ? { credits: scope.spend } : {}),
          // Whose `Authentication-Results` this mailbox may believe, resolved from the
          // SAME host string the adapter above dials. Empty for every provider the table does
          // not name, which routes exactly as before this field existed; for Gmail/Microsoft it
          // is what lets a forged known-contact `From` be demoted to the Screener.
          trustedAuthservIds: providerAuthservIds(creds.imap.host),
          // Where that set is empty, the sender's own signature. The account's one-click switch is
          // the cycle's (`screeningFor`); until it is read, one-click letters are not checked.
          signatures: { ...scope.signatureCheck, listLetters: false },
          // One ledger per attachment, and that lifetime is the design. Per mailbox, because a
          // written-off UID is meaningless in another mailbox's folders. Built HERE rather than per
          // cycle, because the two things it remembers are cross-cycle: how many times a message has
          // failed, and which UIDs must stay out of the known-set so their bodies are not re-fetched.
          // A ledger rebuilt per cycle would count every attempt as the first and never reach a
          // terminal decision — the wedge, restated. The paragraph that used to be here is now FALSE:
          // it claimed a restart was how a parser fix reached skipped Sent mail, but the Sent cursor is
          // a UID watermark, so a restart does NOT re-offer a skipped UID (mail loss). Mail 0041 landed
          // the durable table; `runSyncCycle` hydrates this ledger from it, so dropping it on detach now
          // costs nothing.
          deadLetters: new DeadLetterLedger(),
          // One known-set memo per attachment, for the same reason as the ledger. `buildCursor`
          // re-read this mailbox's ENTIRE `message_instances` join at the top of every cycle —
          // thousands of rows a call, once per poll, for the life of the attachment. It is state this
          // process wrote and that nobody else may write while it holds the mailbox, so it is
          // remembered, and any write that could move it drops the memo (see `known-set.ts`). Built per
          // ATTACHMENT, not per process, because the lifetime is the safety argument: a mailbox that
          // changes hands is detached and re-attached and the new runtime starts cold. Dropped
          // explicitly on detach, the lock-loss tripwire and every stand-down — a memo of somebody
          // else's mailbox must stop existing the moment leadership is in doubt.
          // Per attachment, but no longer AT THE SIZE OF THE ROSTER: every memo in this process
          // competes for one byte budget derived from the deployed heap, and taking a projection
          // evicts the least recently used one (`known-set.ts`, `KnownSetBudget`). Nothing is
          // passed here because the bound is the DEFAULT — a memo built without one is bounded.
          knownSet: new KnownSetCache(mb.mailboxId),
          // The account's managed storage cap AT ATTACH — the per-cycle spread below refreshes
          // it, so this value's real job is that the field cannot be forgotten: it is required,
          // and this composition is the metered one.
          storageCap: await scope.storageCapFor(mb.accountId),
          storagePlanLimit: await scope.storageCapFor.planLimit(mb.accountId),
          log: scope.log,
          // The build this process is, as its configuration resolved it and `/health` publishes it:
          // the label a write-off is recorded under, and a new one is what reads it again.
          buildVersion: scope.config.buildVersion ?? UNLABELLED_BUILD,
          // `OHMAIL_BLANK_REPAIR`, as the config read it: unset is apply (`blank-repair.ts`).
          ...(scope.config.blankRepair !== undefined ? { blankRepair: scope.config.blankRepair } : {}),
          // `OHMAIL_INGEST_RUNS`: new letters stored in runs, through the fence's repository.
          ...(scope.config.ingestRuns ? { ingestRuns: scope.config.ingestRuns } : {}),
          // ── THE ONE-TIME SWEEP'S COMMAND PORT (FOLDERS-SPEC.md §16.1) ─────────────────
          //
          // Built HERE because this is where the database handle and this mailbox's adapter
          // meet. `requested` reads the stamp as the server renders it; `run` is `junkSweepPass`
          // — the operator CLI's exact function — with the cycle's fences threaded in: the
          // leadership `guard` before every chunk's IMAP move, and a repo whose `transaction`
          // IS the fenced group, so every completion write rides the same fence the ingest and
          // reconcile groups do; `clear` retires only the observed token (`sync-kick.ts`'s
          // compare-the-text discipline), so a press landing mid-sweep is served next cycle.
          junkSweep: {
            requested: async () => {
              const [row] = await scope.db
                .select({
                  at: sql<string | null>`${mailboxes.junkSweepRequestedAt}::text`,
                  off: mailboxes.foldersDisabledAt,
                })
                .from(mailboxes)
                .where(eq(mailboxes.id, mb.mailboxId))
                .limit(1);
              if (!row || row.at === null) return null;
              if (row.off !== null) {
                // Switched off under "Use folders" since the press (§17): an opted-out mailbox
                // performs no move on the feature's account. The stale stamp is retired here
                // — at its observed value — so the offer does not read "queued" for ever.
                await scope.db.update(mailboxes)
                  .set({ junkSweepRequestedAt: null })
                  .where(and(
                    eq(mailboxes.id, mb.mailboxId),
                    sql`${mailboxes.junkSweepRequestedAt} = ${row.at}::timestamptz`,
                  ));
                scope.log.info("junk_sweep_command_dropped", {
                  mailboxId: mb.mailboxId, accountId: mb.accountId,
                  reason: "the mailbox was switched off under Use folders after the press; nothing moves",
                });
                return null;
              }
              return row.at;
            },
            run: async (hooks) => {
              // ONE PRESS, ONE SCAN STATE — the reset is a named decision in `junk-sweep.ts`
              // rather than a conditional here, because a decision spelled inline in this file is
              // one nothing can assert. See `SweepScanState.command`.
              sweepScan = sweepStateForPress(sweepScan, hooks.command);
              const fencedRepo = new Proxy(scope.repo, {
                get: (target, key, receiver) =>
                  key === "transaction" ? hooks.write : Reflect.get(target, key, receiver),
              }) as typeof scope.repo & { transaction: typeof hooks.write };
              /**
               * ONE BOUNDED WINDOW PER CYCLE on a KEYSET cursor, with the scan's state carried
               * across cycles in the attachment ({@link adoptSweepWindow} is the whole decision,
               * pinned by test): the cursor advances until the scan runs off the end, and
               * `examinedAll` is true precisely when a WHOLE scan — top to end, however many
               * cycles it took — moved nothing. That is what lets `sync.ts` retire the command
               * over a pile the server refuses outright, without ever walking more than one
               * window inside one cycle.
               */
              const res = await junkSweepPass({
                db: scope.db as unknown as Tx, repo: fencedRepo, adapter: attachedAdapter,
                accountId: mb.accountId, mailboxId: mb.mailboxId, execute: true,
                writeAuthority: hooks.writeAuthority,
                limit: JUNK_SWEEP_PER_CYCLE,
                ...(sweepScan.after !== null ? { afterId: sweepScan.after } : {}),
              });
              const adopted = adoptSweepWindow(sweepScan, {
                movedCount: res.moved.length,
                candidates: res.candidates.length,
                lastId: res.candidates.at(-1)?.messageId ?? null,
                junkFolder: res.junkFolder,
                deferredCount: res.deferred,
              }, JUNK_SWEEP_PER_CYCLE);
              sweepScan = adopted.state;
              return {
                moved: res.moved, skipped: res.skipped, junkFolder: res.junkFolder,
                // The scan's deferrals, not this window's. `res.deferred` is one window, and the
                // cursor moves past a deferred member, so the FINAL window of a multi-window scan can
                // honestly report zero while a row it deferred earlier is still in the pile — and the
                // retirement rule would then retire the command over exactly the mail the deferral
                // protected. So what crosses this boundary is the accumulated fact, in `SweepScanState`
                // beside `movedSinceTop`. `exhaustedDeferrals` is the termination bound: after three
                // consecutive completed scans kept alive by deferrals alone, the exemption stops and
                // the command may retire — without it, a stale locator nothing repoints keeps the
                // command queued and the mailbox re-kicked for ever.
                deferred: res.deferred,
                deferralsHold: adopted.deferralsHold,
                examinedAll: adopted.examinedAll,
              };
            },
            remaining: async () => {
              const [row] = await scope.db
                .select({ n: sql<number>`count(*)::int` })
                .from(messages)
                .innerJoin(folderState, eq(folderState.messageId, messages.id))
                .where(junkSweepCandidateWhere(mb.accountId, mb.mailboxId));
              return Number(row?.n ?? 0);
            },
            clear: async (observed) => {
              await scope.db.update(mailboxes)
                .set({ junkSweepRequestedAt: null })
                .where(and(
                  eq(mailboxes.id, mb.mailboxId),
                  sql`${mailboxes.junkSweepRequestedAt} = ${observed}::timestamptz`,
                ));
            },
          },
        };

        ticket.checkpoint();
        // The runtime is BUILT here and joins `runtimes` only at the end, once IDLE is up. Attaches run
        // beside the queue now (the pool), so a cycle may be running while this one works: a mailbox in
        // the rotation is one whose attach has finished, and nothing reads it before that. `unwatch`
        // is patched onto this object when IDLE is established.
        const rt: MailboxRuntime = {
          accountId: mb.accountId, mailboxId: mb.mailboxId, adapter, deps, unwatch: null,
          requestKey: deriveRequestKey({ auth: creds.imap.auth, address: mb.address }),
          failures: 0, lastSuccessAt: null, leaseNonce: leaseState.leaseNonce,
          leaseMintedNonces: leaseState.leaseMintedNonces,
          seenClockCorrections: leaseState.seenClockCorrections,
          leasePermit: leaseState.leasePermit,
          lease: leaseRow,
          // Mail 0083. Mutable, and re-read by every cycle — see the fields.
          role,
          holderSeen,
          // A FRESH CONNECTION HAS NOT FAILED TO READ ANYTHING YET. The gate above
          // just answered organize over this very socket, so starting anywhere but `null` would
          // charge the new connection for the dead one's silence.
          leaseUnavailableSince: null,
          // Attach no longer proves a sync, so what "recovered" means moved with the drain. See
          // the comment on this field and the one below `mailbox_attached`.
          needsRecovery: mb.status !== "connected",
          // Both start empty because a fresh runtime has reported nothing: it has not said
          // it owes a backlog and its IDLE has not fired. See the fields for why "unknown" resolves
          // to LIGHT here and not to heavy.
          owesBacklog: false,
          // The profile's write-behind, beside the lease it rides: same identity, same store,
          // ticked only from a cycle the gate admitted. The release, then `config.buildVersion`
          // (the label the health endpoint reports): which release wrote a copy is what tells a
          // rollback's copy from a restored store's.
          profile: new OrganizerProfileSync({
            db: scope.db, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
            self: { installId: scope.organizerInstallId, kind: "cloud" },
            producerVersion: profileProducerVersion(scope.config.buildVersion ?? "dev"),
            ...(scope.config.organizer?.profileFlushIntervalMs !== undefined
              ? { flushIntervalMs: scope.config.organizer.profileFlushIntervalMs } : {}),
            ...(scope.config.organizer?.profileTidy !== undefined ? { tidyMode: scope.config.organizer.profileTidy } : {}),
            log: (event, detail) => {
              if (/_failed$/.test(event)) scope.log.warn(event, detail);
              else scope.log.info(event, detail);
            },
          }),
          wokenAt: null,
          lastVisitEndedAt: null,
          turnMessages: TURN_START_MESSAGES,
          longTurns: false,
        };

        // Arm the profile hold before the first routing decision (TAKEOVER-RESCREEN). A mailbox taken
        // over from another organizer arrives CARRYING its decisions — the travelling profile in
        // `ohmail/_meta`. The write-behind's ordinary seed discovers it at the END of the first cycle,
        // after that cycle has already routed: the drill measured a cold takeover moving all 31 INBOX
        // messages of already-screened-in senders into the Screener while the document answering for
        // them sat one FETCH away. This read-only detection runs here — after the lease gate said
        // organize, before any cycle can route — so `cycle()`'s `importHold` is set from the
        // first ingest. Never throws; a read fault retries at the first tick and the residual is at
        // most one pre-fix cycle. Ordinary mailboxes return in one FETCH and arm nothing.
        /* Skipped for a reader: the profile hold is an incoming organizer's question. The third of the
         * four skips. `armHoldFromFolder` exists so an organizer TAKING a mailbox over does not
         * re-screen the decisions it is inheriting — it detects a foreign profile document, holds it,
         * and asks whether to import. A reader inherits nothing and decides nothing, so there is no
         * question to hold; arming it would put a pending import prompt on screen for a mailbox this
         * install does not organize (the read is harmless, but the MARKER is what the confirm surface
         * renders). A PROMOTION does not come through here: mail 0083 promotes a reader IN PLACE on the
         * cycle path, which arms its own hold there — the two call sites are the two ways a process can
         * become this mailbox's organizer. */
        if (role === "organizer") await rt.profile.armHoldFromFolder();
        // A promotion at attach (the press landed while this process was down) owes the same sweep.
        if (role === "organizer" && leaseState.agreeStamp) {
          rt.agreeSweep = { stamp: leaseState.agreeStamp, cursor: null };
          await scope.agreeSweepVisit(rt);
        }
        leaseState.agreeStamp = null;
        ticket.checkpoint();

        // Make the mailbox Screener-shaped, once, before the first drain. Here and not in `cycle()`:
        // it is a once-per-mailbox pass (`mailboxes.kickstart_at`, mail 0025) that must run BEFORE the
        // first drain — import the Sent folder's recipients into `contacts` first and the very first
        // routing decision already knows the user's correspondents; import them afterwards and hundreds
        // of messages have been filed into the Screener and need re-routing. The ordering holds because
        // the mailbox joins `runtimes` only at the end of this function, so no cycle can visit it before
        // this kickstart has returned. It stays here
        // because it is once-per-mailbox and marker-gated, and a virgin Screener backlog is empty. A
        // FAILURE MUST NOT FAIL THE ATTACH — the marker is written only on success, so the next attach retries.
        const tKickstart = Date.now();
        /* -- SKIPPED FOR A READER: THE KICKSTART RE-ROUTES THE SCREENER BACKLOG ---------------
         *
         * The second of the four skips. `runKickstart` imports the Sent folder's recipients into
         * `contacts` and then RE-ROUTES the Screener backlog — physical IMAP moves, once per
         * mailbox, on the organizer's authority. Its marker (`mailboxes.kickstart_at`) is
         * deliberately left unwritten here, so a reader that is later promoted runs it on the
         * attach after the promotion, which is the first moment it is entitled to.
         */
        try {
          const shaped = role === "reader" ? { ran: false } as Awaited<ReturnType<typeof runKickstart>> : await runKickstart({
            repo: scope.repo, adapter, accountId: mb.accountId, mailboxId: mb.mailboxId, log: scope.log,
          });
          if (shaped.ran) {
            scope.log.info("mailbox_kickstarted", {
              mailboxId: mb.mailboxId, accountId: mb.accountId,
              sentRecipients: shaped.sentRecipients, contactsImported: shaped.contactsImported,
              examined: shaped.examined, rerouted: shaped.rerouted, truncated: shaped.truncated,
            });
          }
        } catch (err) {
          scope.log.error("kickstart_failed", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            reason: "the mailbox is attached and syncing; the kickstart marker is unwritten, so " +
              "the next attach retries it",
          });
        }

        const kickstartMs = Date.now() - tKickstart;
        ticket.checkpoint();

        // Nothing that drains runs here — a rule now applied to the drain itself. Two changes deleted
        // work from this line for the same reason. The first ran `runThreadBackfill` here: minutes of
        // pure database work while the connection above was dialled, authenticated, NOT yet in IDLE
        // and with nothing awaiting it — the socket outlived its timeout, imapflow emitted the failure
        // on a client with no `error` listener, and an uncaught exception took the process down every
        // ~26 s (try/catch could not help — the throw did not come out of the call it wrapped). The
        // rule: nothing that does not need the connection runs while the connection is held and
        // unattended. A later measurement covered what was still here (`reconcileOnRestart`, two full
        // cycles, ~six minutes for one mailbox, false `sync_lag` pages every deploy), so restart
        // convergence rides `cycle()` now — every-cycle-until-converged, and no classifier on this path.
        const tWatch = Date.now();
        // ── THE DOORBELL NOW SAYS WHO RANG IT ──────────────────────────────────────────────────
        //
        // `kickCycle()` alone schedules a ROTATION, so a mailbox whose IDLE fired joined the back
        // of a queue containing every other mailbox on the shard — a sub-second wake channel in
        // front of a 15.5-minute queue, measured. `noteWake` marks THIS runtime, which is what
        // lets `cycle()` order the rotation by who is actually waiting; the kick is unchanged and
        // still the thing that makes a cycle happen at all.
        unwatch = await adapter.watch(() => { scope.noteWake(mb.mailboxId); scope.kickCycle(); });
        rt.unwatch = unwatch;
        ticket.checkpoint();
        if (scope.stopped) throw new AttachAbortedError("stop");
        // Unreachable by construction (the pool keys the mailbox, the roster skips an attached one),
        // and checked rather than trusted: two runtimes of one mailbox would be two organizers.
        if (scope.runtimes.has(mb.mailboxId)) {
          scope.log.error("mailbox_attach_duplicate", {
            mailboxId: mb.mailboxId, accountId: mb.accountId,
            reason: "the mailbox was already in the rotation when this attach finished; this " +
              "connection is closed and the one in the rotation keeps serving",
          });
          throw new AttachAbortedError("stop");
        }
        // JOIN THE ROTATION LAST, then make it heard: the kick queues a cycle, and the nudge wakes one
        // already blocked on its lanes, whose dispatcher admits a never-synced mailbox at the front.
        scope.runtimes.set(mb.mailboxId, rt);
        // The quarantine entry is NOT cleared here. It moved with the drain.
        // `quarantine.delete(mb.mailboxId)` was the last line of this function, and its reason was
        // exact: the entry carries the exponential backoff's attempt count, and clearing it BEFORE the
        // drain would reset a struggling provider's backoff to the base delay on every retry — the
        // mailbox hammered at the minimum interval for ever. The drain moved, so "the end of a
        // successful attach" IS now "before the drain", and leaving the delete here reintroduces
        // exactly that bug: a login the provider accepts whose every sync cycle throws would attach,
        // clear the count, fail into a fresh attempts=1 quarantine, and re-attach for ever at
        // `retryBaseMs` — a silent DoS (`stats()` excludes anything in `runtimes`). It is spent on the
        // first SUCCESSFUL cycle instead, beside the recovery write (`mailbox-failure.e2e.test.ts`).

        // ── THE PHASE BREAKDOWN, SO THE NEXT BOOT ANSWERS "WHICH PHASE" ITSELF ────────────
        //
        // The measurement could not say which phase dominated the six minutes, because the only two timestamps
        // in the log were the two ends of the whole function. These five are now the whole of what
        // attach does, and `attachMs` brackets exactly them: the clock starts immediately after
        // `mailbox_attach_started`, so the credential read and `makeAdapter` sit deliberately
        // OUTSIDE it — they are already bounded by the gap between `attach_started` and the
        // previous line in the log, and including them would make the five phases stop summing.
        scope.log.info("mailbox_attached", {
          mailboxId: mb.mailboxId, accountId: mb.accountId,
          connectMs, leaseMs, foldersMs, kickstartMs, watchMs: Date.now() - tWatch,
          attachMs: Date.now() - tAttach,
        });
        scope.kickCycle();
        scope.nudgeCycle();
        // Beat per attach, so a roster of several real mailboxes reports progress while it is
        // still working through them rather than only once the last one is up.
        await scope.beat();
        // The recovery write is NOT here. It is on the cycle path. It used to be, and the definition it
        // enforced was "connect + folders + two full sync cycles + IDLE": the heartbeat may count a
        // mailbox mid-drain, but the STATUS COLUMN may only say `connected` about one that has actually
        // synced (or Settings shows "connected" flashes on a mailbox that has never synced). That
        // invariant is unchanged, but "two inline cycles" was a PROXY for "actually synced", available
        // here only because the drain was here. With the drain on the cycle loop the real thing is
        // available: `rt.needsRecovery` is spent in `cycle()` after the first successful `runSyncCycle`,
        // and a mailbox whose cycles all throw accumulates toward quarantine without ever being called
        // connected. Writing it here now would mean "the login worked" — strictly weaker.
      } catch (err) {
        if (unwatch) { try { await unwatch(); } catch { /* ignore */ } }
        /* A `_meta` too full to read is swept on the login that met it, before it closes: the
           attach refuses every pass otherwise, and nothing else would ever make it smaller. Not over
           a connection a deadline or a stop closed, or one reported lost: there is no login left. */
        if (adapter && ticket.aborted === null && ticket.lost === null) {
          await shrinkMetaOnRefusal(err, {
            mailboxId: mb.mailboxId, accountId: mb.accountId, installId: scope.organizerInstallId, adapter,
          }, new Date(), (event, detail) => { scope.log.info(event, detail); });
        }
        if (adapter) { try { await adapter.close(); } catch { /* ignore */ } }  // never leak a half-open login
        // Nothing to take out of `runtimes`: the mailbox joins it only as the last step of a success.
        // A shared-service fault is not this mailbox's fault. The credential read moved inside this
        // `try`, and that read is a DATABASE read. Left unexempted, one database blip would quarantine
        // every mailbox of the shard in turn and write `status='error'` on each — "the database was
        // unreachable for ninety seconds" rendered as "your mailbox is broken", a measured incident's
        // exact shape. So it is rethrown: the roster pass fails, no mailbox row is touched, no backoff
        // is earned, and the next pass retries the whole roster. Exempted BY CLASS, like
        // `LeaseUnavailableError` — a threshold cannot be tuned into a wrong answer — while everything
        // genuinely attributable to THIS mailbox (an undecryptable envelope, a refused configuration, a
        // rejected login) still quarantines, and iteration continues to the next mailbox.
        if (isDatabaseFault(err)) {
          scope.log.error("mailbox_attach_database_fault", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            reason: "a shared database or transport failure, NOT this mailbox — the roster pass " +
              "fails without marking any mailbox at fault, and the next pass retries",
          });
          throw err;
        }
        // A STOP is not the mailbox's fault either: the process is going down, or lost its lock, and
        // the next leader attaches it. No row is written and no backoff is earned.
        const aborted = ticket.aborted ?? (err instanceof AttachAbortedError ? err.why : null);
        if (aborted === "stop") {
          scope.log.info("mailbox_attach_stopped", {
            mailboxId: mb.mailboxId, accountId: mb.accountId,
            reason: "the worker stopped while this mailbox was attaching; its connection is closed",
          });
          return;
        }
        // A DEADLINE IS the mailbox's provider: it backs off as a timeout. Before the lease arm, because a
        // connection force-closed inside the lease gate surfaces as `LeaseUnavailableError`, and that arm
        // would re-dial a hung provider every pass with no backoff.
        if (aborted === "deadline") {
          await scope.quarantineMailbox(mb.mailboxId, mb.accountId, new AttachDeadlineError(scope.attachDeadlineMs), "attach");
          return;
        }
        // A lease we could not read is not a broken mailbox, and must not be quarantined into an
        // exponential backoff. Exempted BY CLASS, the pattern `ClassifierFaultError` establishes below:
        // exempting by class rather than threshold arithmetic keeps "an infrastructure fault can never
        // quarantine a mailbox" true at every tuning of `maxSyncFailures`. The mailbox is simply not
        // attached this pass; the next pass (thirty seconds) tries again, and the ONLY thing that did
        // not happen is organizing a mailbox we could not prove was ours. Since mail 0029 it RECORDS,
        // and `reconcileSyncBlocks` decides whether the state lasted long enough for the row — until
        // that split existed this arm's `log.warn` was the only trace of a mailbox nothing was syncing,
        // and it once stayed the only trace for half an hour.
        if (err instanceof LeaseUnavailableError) {
          scope.noteBlock(scope.leaseBlocked, mb.mailboxId, leaseBlockReason(err));
          scope.log.warn("attach_lease_unavailable", {
            mailboxId: mb.mailboxId, accountId: mb.accountId, err,
            // The OPERATION, from the error rather than from this call site: `runLeaseGate` names
            // which of `ensure_meta` / `list_claims` / `renew_claim` / `remove_claims` threw, and
            // it is a compile-time literal so it carries no privacy cost. Without it "the lease
            // could not be read" is one sentence for four different faults.
            op: err.op,
            reason: "the organizer lease could not be read — NOT counted toward maxSyncFailures; " +
              "the mailbox is left unattached and the next roster pass retries it",
          });
          return;
        }
        await scope.quarantineMailbox(mb.mailboxId, mb.accountId, err, "attach");
      }
    }
    scope.detach = detach;
    scope.attach = attach;
}
