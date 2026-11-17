import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import {
  ImapAdapter, ImapConnectionClosedError, isImapBoundExceeded, storedTlsPin, type ImapConfig, type MailboxAdapter,
} from "@trafficflow/core/adapters/imap";
import { providerAuthservIds } from "@trafficflow/core/mail";
import { organizerDisplayName } from "@trafficflow/db";
import { nodeHostResolver } from "@trafficflow/services/mail";
import { plaintextDialPin } from "@trafficflow/api/local";
import { DeadLetterLedger } from "@ohmail/organizer/dead-letter";
import { readMailboxLease, LeaseUnavailableError } from "@ohmail/organizer/lease";
import {
  type LeasePeekIo, isMalformed, metaReadBudget, parseClaim, writtenByThisProcess, type LeaseSelf,
} from "@trafficflow/core/adapters/organizer-lease";
import { holderIsLive } from "@trafficflow/core/reader-refusal";
import type { LocalRosterRow } from "./identity.js";
import type { CandidateClaim, CandidateDial, CredentialBlock } from "./roster.js";
import { cadenceDue, stampNow } from "./pass-cadence.js";
import { createFirstSyncTracker } from "./first-sync.js";
import type { AdapterDialContext, SidecarConfig } from "./engine-types.js";
import { releaseOwnClaim } from "./engine-local-services.js";
import { CANDIDATE_DIAL, ConnectionReplacedError, WallWait, redialStepMs } from "./engine-reconnect.js";
import { seedDial, fetchRefusal, isConnectionFailure } from "./engine-classifiers.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";

/**
 * The desktop's engine, one section: one mailbox's connection: the redial ladder, the candidate's claim, the death
 * and cycle notes, the heartbeat.
 */
export function connectionSection(
  scope: EngineScope, box: MailboxScope, config: SidecarConfig, mb: LocalRosterRow,
): void {
      /**
       * WHAT THIS MAILBOX'S FIRST SYNC HAS PRODUCED — the third answer the connection record
       * carries, derived from the drain's own stamps and the mirror's own rows. See
       * {@link createFirstSyncTracker}: nothing here can set it, which is the point.
       */
      const firstSync = createFirstSyncTracker(scope.log, mb.id, { importStamped: box.importStamped });
      /**
       * A CREDENTIAL CHANGED, so the refusal is no longer evidence about anything.
       *
       * The next poll dials again on its own; nothing here needs to force one. Also resets the
       * backoff, because a new password is a new question and it should be asked promptly rather
       * than at the end of whatever wait the old one had earned.
       */
      const clearSignInRefusal = (why: string, next = "the next poll dials again"): void => {
        if (!box.signInRefused && box.redialAttempts === 0) return;
        box.signInRefused = false;
        box.redialAttempts = 0;
        redialWait.clear();
        /* …and the manual floor with them, for this method's own stated reason: a new password
           is a new question, and it should be asked promptly rather than at the end of a wait
           the old one earned. */
        forcedWait.clear();
        scope.log("mailbox_sign_in_retry_armed", {
          mailboxId: mb.id,
          reason: `${why}; the stored refusal is discarded and ${next}`,
        });
      };
      /** Backoff for the failures that MAY pass. Attempts since the last successful dial. */
      box.redialAttempts = 0;
      /**
       * THE RE-DIAL IN FLIGHT, waiting for its first served cycle. The re-dial drains inside
       * itself, and a first import is minutes of it: its connection is proven when it serves a
       * cycle ({@link noteCycleServed}), not when the whole drain returns.
       */
      box.reconnectProof = null;
      /** No re-dial is attempted while this has time left. */
      const redialWait = new WallWait();
      /**
       * While this has time left a press is not honoured — a floor under the one path
       * allowed to skip the ladder. A forced dial skips {@link redialWait} and a fast failure
       * settles in under a second, so without this a second press dials again and repeated presses
       * defeat the 15 s–5 min ladder against a server already refusing. A press is worth ONE
       * attempt per base step: after a forced dial fails this is armed with `reconnect.ladderMs[0]`
       * and `force` is refused until it passes (the press still answers 202); a successful dial
       * clears it. Kept separate from `redialWait` — that widens to five minutes; folding them
       * would give a press the long wait back or let it reset the ladder.
       */
      const forcedWait = new WallWait();
      /** The floor under {@link LocalMailboxRuntime.networkReturned}, its own for the press's reason. */
      const networkWait = new WallWait();

      /**
       * Which connection this mailbox is on — a counter, bumped by every dial. The identity a
       * pass needs is not "the adapter object" (a binding can be swapped under an `await`) and
       * not "is it open" (it can be open and be the WRONG one) — it is WHICH dial. Two things
       * key on it: a death report names the generation it came from, so a late `error` from a
       * replaced connection cannot mark its healthy replacement dead; and a drain names the
       * generation it read the lease under, refusing to keep running if that stops being current
       * — see {@link ConnectionReplacedError}.
       */
      box.generation = 0;
      /** The dial whose login `dialAndGate` opened; behind {@link generation} while a re-dial connects. */
      box.loginGeneration = 0;
      /**
       * WHICH DIAL THE RECORDED DEATH BELONGS TO, and whether it was a read bound retiring it. A
       * re-dial's own connection can die inside its gate while the previous death is still on
       * record; keyed on the generation, that is news, and the re-dial does not clear it. A
       * breach-retired adapter refuses every call, so no cycle drains over it (`syncUntilQuiet`).
       */
      box.deadGeneration = 0;
      box.deadByBreach = false;

      /**
       * REFUSE TO CONTINUE A PASS WHOSE CONNECTION HAS BEEN REPLACED.
       *
       * Called before every step that WRITES to the mailbox on the strength of a lease read:
       * `ensureFolders`, the cycles that move mail, and the scheduled-send pass. Reading is not
       * gated by it — a mirror growing over a fresh connection harms nobody.
       */
      const assertSameConnection = (gen: number, conn: MailboxAdapter): void => {
        /* BOTH, and the instance is not belt-and-braces. The generation says "a re-dial has
           happened since"; the instance says "the object I am about to write through is the one
           whose lease I read". They can disagree in one direction that matters: a helper handed a
           captured adapter can outlive the binding, and a number alone would not notice. Checking
           the pair makes the guard a statement about the CONNECTION rather than about a counter. */
        if (gen !== box.generation || conn !== box.adapter) throw new ConnectionReplacedError(gen, box.generation);
      };

      /**
       * ONE STEP UP THE RE-DIAL LADDER — the ONE writer of the automatic wait.
       *
       * Extracted rather than written twice: a launch that cannot READ its password retries the
       * READ on this same schedule, and a second copy of the jitter would be a second cadence
       * nobody keeps in step with the first. Jittered so several mailboxes on one server do not
       * knock in unison after an outage.
       */
      const jittered = (stepMs: number): number => Math.round(stepMs * (0.8 + Math.random() * 0.4));
      const climbTheLadder = (): void => {
        box.redialAttempts += 1;
        redialWait.arm(jittered(redialStepMs(scope.reconnect, box.redialAttempts)));
      };

      /**
       * THE STORED PASSWORD COULD NOT BE USED, AND THAT IS AN OUTAGE — see {@link credentialBlock}.
       *
       * `start()` used to return here in silence: nothing dialled, no detector fired,
       * `outageSince` stayed null and the connections route answered `reachable: true`, so
       * Settings said "Up to date" over a mailbox that had stopped syncing. The clocks are the
       * SAME two an unreachable server sets — `connectionDeadSince` is what arms the retry,
       * `outageSince` is what a person is shown — and the schedule is the same ladder, because a
       * password that opens on the next read is a mailbox that heals without a restart.
       */
      const noteLoginUnusable = (state: CredentialBlock["state"]): void => {
        if (box.stopped) return;
        box.credentialBlock = { state, confirmed: false };
        if (box.connectionDeadSince === null) {
          box.connectionDeadSince = scope.now();
          box.connectionDeadBy = "credential";
        }
        box.outageSince ??= box.connectionDeadSince;
        scope.log("mailbox_login_unavailable", {
          mailboxId: mb.id,
          state,
          verdict: "first-read",
          reason: "this launch holds a stored password it could not dial with, so nothing was " +
            "connected and this mailbox is not syncing. The row is untouched and is NOT thrown " +
            "away; the next poll reads it again, and re-entering the password re-seals it",
        });
      };

      /**
       * THE HOST AND LOGIN THIS RUNTIME CLAIMED BEFORE THE ROW MOVED THERE — see
       * {@link claimOnCandidate}. The one other mailbox {@link adoptRowDial} may follow: set by the
       * move's keep, spent by the next follow.
       */
      let claimedHost: { host: string; user: string } | null = null;
      /**
       * A MOVE HOLDS THE QUEUE — set from the candidate's dial to its keep or abandon. No re-dial of
       * the old server starts meanwhile: its gate would queue behind the move and then claim the
       * folder the keep has just released.
       */
      box.moving = false;

      /**
       * FOLLOW THE ROW'S PORT AND TLS MODE — the same mailbox, dialled differently. A different host
       * or login is a different mailbox to the lease and is followed only where this runtime has
       * already claimed it ({@link claimedHost}). Answers whether the dial moved; the next dial is
       * built from the new values.
       */
      const adoptRowDial = async (): Promise<boolean> => {
        const claimed = claimedHost;
        claimedHost = null;
        const row = await box.storedLogin();
        const meta = (row?.meta ?? null) as
          { host?: unknown; port?: unknown; secure?: unknown; user?: unknown; insecureConsent?: unknown } | null;
        if (meta === null || typeof meta.host !== "string" || typeof meta.port !== "number"
          || typeof meta.secure !== "boolean") return false;
        const same = (a: unknown, b: string): boolean => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
        const at = (host: string, user: string): boolean => same(meta.host, host)
          && (meta.user === undefined || same(meta.user, user));
        const hostMoved = !at(box.mbImap.host, box.mbImap.auth.user);
        if (hostMoved && (claimed === null || !at(claimed.host, claimed.user))) return false;
        const allowInsecure = meta.insecureConsent === true;
        const tlsPin = storedTlsPin(meta);
        if (!hostMoved && meta.port === box.mbImap.port && meta.secure === box.mbImap.secure
          && allowInsecure === (box.mbImap.allowInsecure === true)
          && tlsPin?.sha256 === box.mbImap.tlsPin?.sha256) return false;
        const { allowInsecure: _was, tlsPin: _pinned, ...rest } = box.mbImap;
        const user = typeof meta.user === "string" ? meta.user : box.mbImap.auth.user;
        box.mbImap = {
          ...rest, host: meta.host, port: meta.port, secure: meta.secure, auth: { ...box.mbImap.auth, user },
          ...(allowInsecure ? { allowInsecure: true } : {}),
          ...(tlsPin ? { tlsPin } : {}),
        };
        box.imapConfig.host = meta.host;
        box.imapConfig.port = meta.port;
        box.imapConfig.secure = meta.secure;
        box.imapConfig.auth = { ...box.imapConfig.auth, user };
        if (allowInsecure) box.imapConfig.allowInsecure = true; else delete box.imapConfig.allowInsecure;
        if (tlsPin) box.imapConfig.tlsPin = tlsPin; else delete box.imapConfig.tlsPin;
        scope.log("mailbox_dial_moved", {
          mailboxId: mb.id,
          reason: hostMoved
            ? "this mailbox's incoming server was changed after this install claimed it there, so "
              + "the connection is re-opened on the new server and renews that claim"
            : "this mailbox's port or encryption was changed and proved, so the connection is "
              + "re-opened on the new setting; the claim in ohmail/_meta is kept",
        });
        return true;
      };

      /**
       * ONE LOOK AT A FOLDER FOR A CLAIM THIS PROCESS WROTE — the candidate server's `ohmail/_meta`
       * under the same install id and a nonce this runtime armed is the running mailbox's own
       * folder under another name. APPEND-less; a folder that cannot be read throws.
       */
      const holdsOwnClaim = async (conn: MailboxAdapter, self: LeaseSelf): Promise<boolean> => {
        const peekIo = (conn as Partial<{ leasePeekIo(): LeasePeekIo }>).leasePeekIo;
        if (typeof peekIo !== "function") return false;
        const raw = await peekIo.call(conn).listClaims();
        return raw.some((m) => {
          const c = parseClaim(m.raw, m.ref, m.internalDate ?? null);
          return c !== null && !isMalformed(c) && c.installId === scope.installId
            && writtenByThisProcess(self, c.nonce);
        });
      };

      /**
       * CLAIM THE CANDIDATE SERVER BEFORE THE ROW MOVES — see `LocalMailboxRuntime.claimOnCandidate`.
       * The candidate is this runtime's own connection to the new server for the length of the move,
       * never a one-shot identity: the claim is written with this runtime's nonces and renewed by it
       * after the follow. The queue is held from the claim until `keep` or `abandon`.
       */
      const claimOnCandidate = (dial: CandidateDial): Promise<CandidateClaim> => new Promise((answer) => {
        void box.serialize(async () => {
          let settle: () => void = () => undefined;
          const held = new Promise<void>((r) => { settle = r; });
          const release = (): void => { box.moving = false; settle(); };
          const cfg: ImapConfig = {
            ...box.imapConfig, host: dial.host, port: dial.port, secure: dial.secure,
            auth: { user: dial.user, pass: dial.pass },
            /* The runtime's own deadlines: this is its connection for the length of the move. */
            timeouts: box.imapConfig.timeouts,
          };
          if (dial.allowInsecure === true) cfg.allowInsecure = true; else delete cfg.allowInsecure;
          const candidate = config.adapterFactory
            ? config.adapterFactory(cfg, CANDIDATE_DIAL)
            : new ImapAdapter(cfg, { onConnectionError: CANDIDATE_DIAL.onConnectionError });
          const closeCandidate = (): Promise<void> => Promise.resolve()
            .then(() => candidate.close()).catch(() => undefined);
          /* WHAT THE RUNNING MAILBOX HOLDS, and what this move minted on ANOTHER server — kept apart
             until the keep, because nothing renews either while the queue is held. */
          const running = { current: box.leaseNonce, minted: box.leaseMinted };
          let minted: string | null = null;
          let sameFolder = false;
          const releaseOn = (conn: MailboxAdapter, nonce: { current: string | null; minted: readonly string[] },
            why: string): Promise<number | "sibling" | null> =>
            metaReadBudget().race(releaseOwnClaim(conn, scope.installId, mb.id, nonce, scope.log, why))
              .catch((err: unknown) => {
                scope.log("organizer_claim_release_failed", { err, mailboxId: mb.id, reason: why });
                return null;
              });
          try {
            if (box.stopped || box.redialling) { answer({ verdict: "refused", holder: null }); return; }
            box.moving = true;
            await pinPlaintextDial(cfg);
            await candidate.connect();
            const self: LeaseSelf = {
              installId: scope.installId, kind: scope.organizerKind, displayName: scope.machineName,
              lastNonce: box.leaseNonce, mintedNonces: box.leaseMinted,
            };
            sameFolder = await holdsOwnClaim(candidate, self);
            const outcome = await readMailboxLease({
              adapter: candidate, mailboxId: mb.id, self, now: scope.now(),
              hasRequestKey: box.requestKey !== null, takeover: null,
              ...(config.leaseStaleAfterMs !== undefined ? { staleAfterMs: config.leaseStaleAfterMs } : {}),
              onNonceMinted: (n: string) => { if (sameFolder) box.noteMinted(n); else minted = n; },
              log: scope.log,
            });
            if (!outcome.organize) {
              await closeCandidate();
              release();
              const by = outcome.by;
              const live = by !== null
                && holderIsLive({ by: { kind: by.kind, name: by.displayName }, state: outcome.state });
              scope.log("organizer_host_change", {
                mailboxId: mb.id, verdict: "refused", state: outcome.state,
                reason: "another install holds this mailbox on the new server, so nothing there was "
                  + "claimed and the row and the running claim are as they were",
              });
              answer({
                verdict: "refused",
                holder: live ? { name: organizerDisplayName(by.displayName) ?? "", kind: by.kind } : null,
              });
              return;
            }
            /* THE SAME FOLDER UNDER ANOTHER NAME: the gate renewed the running claim in place, so its
               nonce is this runtime's from now, kept or not. */
            if (sameFolder) box.leaseNonce = outcome.nonce;
            const candidateNonce = outcome.nonce;
            scope.log("organizer_host_change", {
              mailboxId: mb.id, verdict: "claimed", state: sameFolder ? "same_folder" : "other_server",
              reason: "this install claimed the new server under its own nonce before the row moves",
            });
            let settled = false;
            answer({
              verdict: "organize",
              sameFolder,
              keep: async () => {
                if (settled) return;
                settled = true;
                try {
                  const old = box.adapter;
                  /* THE FOLLOW, STILL INSIDE THE HOLD: a cycle queued behind it must meet the new
                     server's dial and a socket marked replaced, never the folder the move left. */
                  claimedHost = { host: dial.host, user: dial.user };
                  const followed = await adoptRowDial();
                  if (!followed && !sameFolder) {
                    await releaseOn(candidate, { current: candidateNonce, minted: minted === null ? [] : [minted] },
                      "the claim on the new server could not be removed; it ages out of ohmail/_meta there");
                    return;
                  }
                  if (!sameFolder) {
                    await releaseOn(old, running, "the claim on the previous server could not be "
                      + "removed after the mailbox moved; it ages out of ohmail/_meta there");
                    box.leaseNonce = candidateNonce;
                  }
                  if (followed) {
                    await rereadCredential();
                    if (box.connectionDeadSince === null) {
                      box.connectionDeadSince = scope.now();
                      box.connectionDeadBy = "replaced";
                    }
                    try {
                      if (old.forceClose !== undefined) old.forceClose();
                      else void Promise.resolve(old.close()).catch(() => undefined);
                    } catch { /* the socket is going away regardless */ }
                  }
                  scope.log("organizer_host_change", {
                    mailboxId: mb.id, verdict: "kept", state: sameFolder ? "same_folder" : "other_server",
                    reason: "the new server is kept and this install renews its claim there",
                  });
                } finally {
                  await closeCandidate();
                  release();
                }
              },
              abandon: async () => {
                if (settled) return;
                settled = true;
                try {
                  if (!sameFolder) {
                    await releaseOn(candidate, { current: candidateNonce, minted: minted === null ? [] : [minted] },
                      "the claim on the new server could not be removed after the change was not "
                        + "kept; it ages out of ohmail/_meta there");
                  }
                  scope.log("organizer_host_change", {
                    mailboxId: mb.id, verdict: "abandoned", state: sameFolder ? "same_folder" : "other_server",
                    reason: "the change was not kept, so the new server's claim was given back and the "
                      + "running claim stands",
                  });
                } finally {
                  await closeCandidate();
                  release();
                }
              },
            });
            await held;
          } catch (err) {
            /* NOTHING WAS KEPT. A claim minted on another server before the throw is taken back; one
               minted in the running folder is the runtime's own (`leaseMinted`) and stands. */
            if (!sameFolder && minted !== null) {
              await releaseOn(candidate, { current: minted, minted: [] },
                "a claim on the new server could not be removed after the change failed; it ages out");
            }
            await closeCandidate();
            scope.log("organizer_host_change_failed", {
              err, mailboxId: mb.id,
              reason: "the new server could not be claimed, so nothing was kept and the running claim "
                + "stands",
            });
            answer({ verdict: "refused", holder: null });
            release();
          }
        });
      });

      /**
       * READ THE STORED PASSWORD AGAIN, AND USE IT IF IT OPENS. Answers whether it did.
       *
       * No network and no login attempt: a mailbox with no usable password is waiting for a
       * person, and dialling one repeatedly is how a wrong password becomes a locked account. On
       * a read that opens, the connection config and the derived request key move TOGETHER —
       * that key is HKDF over the password this mailbox dials with, so leaving it behind would
       * make every request record refuse as a forgery. A failing read CONFIRMS the block: the
       * advice a person is shown waits for a second, independent reading of the same fact.
       */
      const rereadCredential = async (): Promise<boolean> => {
        const fresh = await box.resolveLogin();
        if (fresh.state === "ready" && fresh.pass) {
          box.login = fresh;
          box.useDialledPassword(fresh.pass);
          box.credentialBlock = null;
          /* AND THE STATE THE LAUNCH ENTERED WITH NO PASSWORD — this read is the thing that ends
             it: a password is stored and this mailbox dials with it from here. */
          box.needsCredential = false;
          box.needsCredentialSince = null;
          scope.log("mailbox_login_restored", {
            mailboxId: mb.id,
            state: fresh.state,
            attempt: box.redialAttempts,
            reason: "the stored password opened on a later read, so this mailbox dials with it " +
              "now rather than at the next launch",
          });
          return true;
        }
        /* A ROW THAT IS GONE IS NOT A BLOCK. Somebody signed out: nothing is stored, the shell
           shows a password field, and claiming an unreadable credential would be a sentence about
           a row that does not exist. The outage clocks are left as they stand: `noteCycleServed`
           clears them when a cycle is served, and {@link purgeCredential} with the password. */
        if (fresh.state === "absent" || fresh.state === "ready") {
          box.credentialBlock = null;
          return false;
        }
        box.credentialBlock = { state: fresh.state, confirmed: true };
        scope.log("mailbox_login_unavailable", {
          mailboxId: mb.id,
          state: fresh.state,
          verdict: "confirmed",
          attempt: box.redialAttempts,
          reason: "a second, fresh read of the stored password answered the same way, so this is " +
            "not a store that was briefly unready and the person is told to sign in again. " +
            "Nothing was deleted: re-entering the password re-seals the row under this key",
        });
        return false;
      };

      /**
       * THE SEED'S PLAINTEXT CONSENT AND TRUSTED CERTIFICATE, re-read from its credential row onto
       * both dial configs — the one other writer of `allowInsecure` and `tlsPin` beside
       * {@link adoptRowDial}, for the mailbox that one never follows. A row that proves TLS (or names
       * another endpoint) takes the consent away; the pin is the row's, or none.
       */
      const adoptSeedConsent = async (): Promise<void> => {
        const dial = seedDial(config.imap, (await box.storedLogin())?.meta ?? null);
        const allowInsecure = dial.allowInsecure === true;
        const tlsPin = dial.tlsPin;
        if (allowInsecure === (box.mbImap.allowInsecure === true) && tlsPin?.sha256 === box.mbImap.tlsPin?.sha256) return;
        const { allowInsecure: _was, tlsPin: _pinned, ...rest } = box.mbImap;
        box.mbImap = { ...rest, ...(allowInsecure ? { allowInsecure: true } : {}), ...(tlsPin ? { tlsPin } : {}) };
        if (allowInsecure) box.imapConfig.allowInsecure = true; else delete box.imapConfig.allowInsecure;
        // The adapter built at attach reads this config at its connect, and every re-dial is built from it.
        if (tlsPin) box.imapConfig.tlsPin = tlsPin; else delete box.imapConfig.tlsPin;
      };

      /**
       * THE PLAINTEXT DIAL'S CHECK, before every connect built from a config of this mailbox: a
       * stored consent is honoured only where the name resolves NOW to the person's own network,
       * and the socket is pinned there. A dial with TLS carries no pin: this door dials by name.
       */
      const pinPlaintextDial = async (cfg: ImapConfig): Promise<void> => {
        if (cfg.allowInsecure !== true || cfg.secure) { delete cfg.pin; return; }
        cfg.pin = await plaintextDialPin(nodeHostResolver, cfg.host, "imap");
      };

      /**
       * BUILD ONE DIAL. Called once at attach and again for every re-dial, because an
       * `ImapAdapter` that has been closed is not the thing to re-open — the worker's re-attach
       * builds a fresh one for the same reason, and a fresh instance is the only shape in which
       * "the factory was called a second time" is observable from outside.
       *
       * The callback closes over BOTH the generation and the adapter INSTANCE it belongs to. The
       * instance is what gets closed (never the mutable binding, which a re-dial may already have
       * moved on) and the generation is what decides whether this death is still news.
       */
      const dialAdapter = (): MailboxAdapter => {
        const gen = ++box.generation;
        let self: MailboxAdapter | null = null;
        const ctx: AdapterDialContext = {
          onConnectionError: (err) => noteConnectionDead(err, gen, self),
        };
        self = config.adapterFactory
          ? config.adapterFactory(box.imapConfig, ctx)
          : new ImapAdapter(box.imapConfig, {
            onConnectionError: ctx.onConnectionError,
            log: (event, detail) => { scope.log(event, { ...detail, mailboxId: mb.id }); },
          });
        return self;
      };

      /**
       * The connection died between calls — the callback `guardAsyncErrors` had nobody to call.
       * Called from an EventEmitter handler, so it does the smallest synchronous work and puts
       * the rest on the serial queue; it must not throw (a handler raising inside an `error`
       * listener is the uncaught exception the listener exists to prevent). First observation
       * wins: imapflow's `_socketClose` can produce `error` then `close`, and the runtime reads
       * "how long has this been dead" — a second event must not restart the clock. It does not
       * re-dial: that would race the cycle running over the adapter it is about to replace; the
       * poll tick owns the re-dial, on the serial queue.
       */
      const noteConnectionDead = (err: unknown, gen: number, who: MailboxAdapter | null): void => {
        if (box.stopped) return;
        /* ── A DEATH FROM A CONNECTION WE HAVE ALREADY REPLACED IS NOT NEWS ──────────────────
         *
         * The real adapter's `error` listener is UNCONDITIONAL — only its `close` listener is
         * guarded by `closing`/`established` (`imap.ts`, `guardAsyncErrors`) — so a connection we
         * deliberately closed during a re-dial can still emit `error` afterwards, from a socket
         * whose replacement is already up and gated. Without this check that late report marks
         * the HEALTHY connection dead, and the next drain re-dials a connection that never
         * failed. Keyed on the generation rather than on `who === adapter`, because the binding
         * is exactly the thing that moves. */
        if (gen !== box.generation) {
          scope.log("mailbox_connection_stale_report", {
            err, mailboxId: mb.id,
            detectedBy: "event",
            reason: "a connection this install has already replaced reported its own death; the " +
              "live connection is a later one and is untouched. Nothing is wrong — a socket we " +
              "closed on purpose is entitled to say so afterwards",
          });
          return;
        }
        const ended = err instanceof ImapConnectionClosedError;
        /* The line counts deaths, which is why it is inside the first-observation guard. One
         * dead socket reaches here twice (imapflow emits `error` then `close` in the same tick,
         * both forwarded, both carrying the same generation — and both correct to arrive: the
         * second covers a clean `BYE` that emits no `error`). The state was always idempotent;
         * the log call used to sit outside this block, so the line doubled — measured on the
         * Windows guest, two `mailbox_connection_unavailable` lines one millisecond apart for
         * one cut cable, making the line count imapflow's arrival paths rather than outages.
         * The second arrival is silent; the close below stays keyed to the reporting
         * connection, not the death.
         */
        /* THE DEATH OF A LATER DIAL IS NEWS even while an earlier one is on record: a re-dial's
           own connection retired inside its gate was swallowed here, and the re-dial then
           cleared the record over a dead socket. The outage clock keeps its first instant. */
        const news = box.connectionDeadSince === null || box.deadGeneration !== gen;
        box.deadGeneration = gen;
        if (news) {
          box.deadByBreach = isImapBoundExceeded(err);
          box.connectionDeadSince ??= scope.now();
          box.connectionDeadBy = "event";
          scope.log("mailbox_connection_unavailable", {
            err, mailboxId: mb.id,
            detectedBy: "event",
            reason: ended
              ? "the mail server connection ENDED and this process is still running, so nothing " +
                "would have re-opened it; the next poll re-dials and re-reads the organizer lease " +
                "before it moves anything"
              : "the mail server connection reported an error and this process is still running; " +
                "the next poll re-dials and re-reads the organizer lease before it moves anything",
          });
        }
        /* OUTSIDE the guard, and it is not the same question. `connectionDeadSince` clears on a
           re-dial that reached a live server; `outageSince` clears only when a cycle is actually
           SERVED (`noteCycleServed`), so the two can be in states where a later death has to
           re-arm the person's clock while the death itself is not news. A read bound retiring the
           connection arms nothing here: the server answered, and whether the breach set its message
           aside (progress) is known only at the re-dial, whose failure arm arms the clock. */
        if (!isImapBoundExceeded(err)) box.outageSince ??= box.connectionDeadSince;
        // CLOSED ON THE QUEUE, never inline: a cycle may be mid-batch over this very adapter, and
        // closing it under one is how a drain re-reads mail it already had. `detach()` and the
        // re-dial take the same queue, so whichever runs first, the other sees a settled state.
        /* THE INSTANCE, NEVER THE BINDING. This used to read `await adapter.close()`, which is
           late-bound: by the time the queue reached it a re-dial could have installed a new
           adapter, and the close then retired the healthy replacement. Closing the object that
           reported its own death is correct whatever has happened since. */
        /* AND DESTROYED, NOT LOGGED OUT — the same correction as the re-dial's teardown, on the
           path beside it. A reported death does not mean the driver has closed: an `ETIMEOUT`
           from the socket deadline reaches here from a client that still believes it is usable,
           so `close()` issues a LOGOUT that queues behind the command already hung and never
           settles — holding THIS QUEUE with it, which `drainPass` and `detach()` both take. The
           re-dial runs outside the queue, so what that cost was not the dial: the mailbox
           re-connected, logged `mailbox_reconnected`, and then never served another cycle or
           finished a `stop()`. Destroying the socket is also what ends the hung command. */
        const dying = who;
        if (dying !== null) {
          void box.serialize(async () => {
            if (dying.forceClose !== undefined) {
              try { dying.forceClose(); } catch { /* the socket is going away regardless */ }
              return;
            }
            try { await dying.close(); } catch { /* the connection is already broken */ }
          }).catch(() => { /* `serialize` never rejects for the caller's sake; belt and braces */ });
        }
      };

      /**
       * THE DURATION BOUND'S TWO READINGS — both derived from cycles that actually ran.
       *
       * `since` is when the lease FIRST became unreadable in the current streak, `cycles` how
       * many consecutive drains have failed that way. Neither is configuration: a cycle that
       * serves clears both, so the state describes what this connection has been doing rather
       * than what somebody set.
       */
      box.leaseUnavailableSince = null;
      box.leaseUnavailableCycles = 0;

      /**
       * A DRAIN CAME BACK. The connection served, so the streak is over and so is any deadness
       * the bound had concluded from it.
       *
       * It does NOT clear a death the ADAPTER reported. An event-marked connection is one the
       * driver has told us is gone, and no amount of a drain returning zero cycles over it
       * changes that — a stopped runtime returns 0 without touching the socket at all. Only a
       * re-dial clears that one, at the first cycle its new connection serves.
       */
      const noteCycleServed = (): void => {
        /* A STOPPED DRAIN NEITHER COUNTS NOR CLEARS. `drainPass` returns 0 at `stopped` without
           touching the socket, so treating that as "the connection served a cycle" let a
           `detach()` racing a sync erase a death the bound had correctly concluded. Nothing about
           a runtime that has been told to stop is evidence about its connection. */
        if (box.stopped) return;
        // A cycle was served: the store counts it toward what its copy from before the update is kept for.
        void scope.opened.copySettled?.(mb.id);
        box.leaseUnavailableSince = null;
        box.leaseUnavailableCycles = 0;
        box.wentQuiet = false;
        if (box.connectionDeadBy === "bound") {
          box.connectionDeadSince = null;
          box.connectionDeadBy = null;
        }
        /* THE PERSON'S CLOCK CLEARS HERE — a cycle was actually served — and at
           {@link purgeCredential}, which removes the password the outage was about. A re-dial that
           reached a live server does not clear it (the socket is not the mailbox); see
           {@link outageSince}. */
        box.outageSince = null;
        /* A served cycle is what the ladder waits for, so it starts over here. */
        box.redialAttempts = 0;
        redialWait.clear();
        /* A RE-DIAL'S FIRST SERVED CYCLE IS THE RECONNECTION — after its lease read, on its own
           connection (a later death of that connection is news keyed on its generation). */
        const proof = box.reconnectProof;
        if (proof !== null && !proof.served && box.deadGeneration !== box.generation) {
          proof.served = true;
          box.connectionDeadSince = null;
          box.connectionDeadBy = null;
          box.certificateRefusedNow = false;
          box.plaintextRefusedNow = false;
          forcedWait.clear();
          scope.log("mailbox_reconnected", {
            mailboxId: mb.id,
            detectedBy: proof.detectedBy ?? "bound",
            totalMs: proof.deadSince ? Date.now() - proof.deadSince.getTime() : 0,
            reason: "the mail server connection was re-opened, the organizer lease was read again " +
              "before anything was moved, and the new connection has served a cycle",
          });
        }
      };

      /* A DRAIN THE DEVICE STORE ENDED, OVER A LIVE SOCKET: the server answered, so the person's
         outage clock ends and the store's sentence is the one said. A socket still known dead
         keeps its clock: nothing was asked of the server then. */
      const noteStoreFaultDrain = (): void => {
        if (box.stopped || box.connectionDeadSince !== null) return;
        box.outageSince = null;
      };

      /**
       * A DRAIN THREW. Only one class counts, and it is the one the wedge produced.
       *
       * `LeaseUnavailableError` is what a dead socket looks like from the gate: `mayOrganize`
       * reads `ohmail/_meta` before anything else happens, the read fails, and the class is the
       * by-class exemption every failure counter honours. Anything else that throws out of a
       * drain — a store fault, a classifier fault, a bug — says nothing about the CONNECTION,
       * and treating it as connection death would re-dial a healthy socket on every unrelated
       * defect.
       */
      const noteCycleFailed = (err: unknown): void => {
        if (box.stopped) return;                       // see `noteCycleServed`
        if (!isConnectionFailure(err)) return;
        box.leaseUnavailableSince ??= stampNow(scope.cadenceClocks);
        box.leaseUnavailableCycles += 1;
        const due = cadenceDue(box.leaseUnavailableSince, scope.reconnect.deadAfterMs, scope.cadenceClocks)
          || box.leaseUnavailableCycles >= scope.reconnect.deadAfterCycles;
        if (!due || box.connectionDeadSince !== null) return;
        box.connectionDeadSince = scope.now();
        box.connectionDeadBy = "bound";
        box.outageSince ??= box.connectionDeadSince;
        scope.log("mailbox_connection_unavailable", {
          err, mailboxId: mb.id,
          detectedBy: "bound",
          // WHICH lease operation failed, from the error and not from this call site — `op` is a
          // compile-time literal off a closed union, so it costs nothing and turns "the lease
          // could not be read" from one sentence into the four different faults it covers.
          // Only a lease failure has one; a reader's plain adapter error reaches here too now,
          // and answers `null` — the census refuses a spread, and rightly: a detail object whose
          // KEYS depend on a value is a line whose shape cannot be read off the call site.
          op: err instanceof LeaseUnavailableError ? err.op : null,
          reason: "the organizer lease has been unreadable for every cycle past the bound, and " +
            "no connection event said so — so the connection is treated as dead on the evidence " +
            "of the cycles themselves; the next drain re-dials and re-reads the lease before it " +
            "moves anything",
        });
      };

      /**
       * THE SERVER ANSWERED AND DECLINED THE READ — one line per SETTLED ATTEMPT.
       *
       * Not a connection line and deliberately not filed as one: `mailbox_connection_unavailable`
       * is what a person is shown "Connection lost" over, and this pass reached an answering
       * server on a standing login. `status` is our own two-member set read off the driver's
       * `responseStatus`; the server's own response text and `[…]` code are never carried — a
       * mailbox over quota must not be able to write its own words into a log line.
       */
      const noteFetchRefused = (err: unknown): void => {
        scope.log("mailbox_fetch_unavailable", {
          err,
          mailboxId: mb.id,
          status: fetchRefusal(err),
          reason: "the mail server answered this pass's FETCH and refused it, so this mailbox's " +
            "mail could not be read; the connection and the sign-in both stand, the drain keeps " +
            "its login, and the next pass asks again",
        });
      };

      /**
       * The third detector: one NOOP per pass, for the death that emits nothing and fails no
       * cycle. On a half-open link the socket answers TCP, every command hangs, and the drain
       * parks inside its first command — `connectionDeadSince` stays null, the field every heal
       * keys on, until the socket deadline fires minutes later. It runs on the public entry
       * point, never inside `serialize`: queued behind a hanging drain it would wait for the
       * hang it exists to detect. A silent window stamps the clock and ends the connection with
       * `forceClose` (a LOGOUT queues behind the abandoned command). A refused NOOP counts as an
       * answer — the question is whether the server is talking at all.
       */
      const probeConnection = async (): Promise<void> => {
        /* A stopped runtime and a connection already known dead are both states in which asking
           changes nothing; the second is `redialIfDead`'s to act on. */
        if (box.stopped || box.connectionDeadSince !== null) return;
        const who = box.adapter;
        const gen = box.generation;
        const probe = who.noop?.bind(who);
        if (probe === undefined) {
          if (!box.heartbeatUnaskable) {
            box.heartbeatUnaskable = true;
            scope.log("mailbox_heartbeat_unavailable", {
              mailboxId: mb.id,
              reason: "this connection cannot be asked to prove itself — the adapter implements " +
                "no NOOP — so a link that goes half-open is detected only when the socket " +
                "deadline fires, which is minutes rather than seconds. Not a failure: nothing " +
                "was asked, which is a different fact from nothing answering",
            });
          }
          return;
        }
        let settled: Promise<"answered">;
        try {
          // Settled, not resolved: an answer and a refusal are both the server talking.
          settled = probe().then(() => "answered" as const, () => "answered" as const);
        } catch {
          return;                       // a synchronous throw is a rejection; not this arm's news
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const elapsed = new Promise<"silent">((resolve) => {
          timer = setTimeout(() => resolve("silent"), scope.heartbeatTimeoutMs);
          timer.unref?.();
        });
        const verdict = await Promise.race([settled, elapsed]);
        if (timer !== undefined) clearTimeout(timer);
        if (verdict === "answered") return;
        /* Re-checked after the await, generation included: this heartbeat was issued on ONE
           connection, and a re-dial or a `detach()` can land while it is outstanding. */
        if (box.stopped || gen !== box.generation || box.connectionDeadSince !== null) return;
        /* An unanswered probe is not yet a dead link: ask whether the server is talking.
         * imapflow writes one command at a time, so a NOOP issued during a legitimately long
         * FETCH still sits in the queue when its window elapses — force-closing there killed a
         * healthy connection and threw the cycle away, and the probe's window alone cannot tell
         * that from a half-open link. The server's own bytes can: a streaming FETCH is heard
         * from continuously, a half-open link not at all — so the window is charged only while
         * the connection is ALSO silent, and a long healthy command is never interrupted.
         * `null` is unknown and deliberately read as silence: an adapter that cannot say leaves
         * the window as the only evidence, and reading it the other way would disarm the detector.
         */
        const heardMs = who.lastServerActivityAt?.()?.getTime() ?? null;
        // A wall-clock stamp a window or more AHEAD predates a clock stepped back: silence too.
        if (heardMs !== null && Math.abs(scope.now().getTime() - heardMs) < scope.heartbeatTimeoutMs) {
          scope.log("mailbox_heartbeat_deferred", {
            mailboxId: mb.id,
            totalMs: scope.heartbeatTimeoutMs,
            reason: "the connection did not answer an IMAP NOOP inside the heartbeat window, and " +
              "the server was heard from inside that same window — so the probe is queued " +
              "behind a command that is still running rather than lost on a dead link. The " +
              "connection is left alone and asked again next window",
          });
          return;
        }
        box.connectionDeadSince = scope.now();
        box.connectionDeadBy = "heartbeat";
        box.outageSince ??= box.connectionDeadSince;               // the person's clock; see the field
        scope.log("mailbox_connection_unavailable", {
          mailboxId: mb.id,
          detectedBy: "heartbeat",
          totalMs: scope.heartbeatTimeoutMs,
          reason: "the connection did not answer an IMAP NOOP inside the heartbeat window while " +
            "its socket was still open, which is the half-open link no connection event and no " +
            "failing cycle describes; this pass ends that connection and re-dials, and the " +
            "organizer lease is re-read before anything is moved",
        });
        // The INSTANCE, never the binding: a re-dial may already have installed a new adapter.
        try { who.forceClose?.(); } catch { /* the socket is going away regardless */ }
      };

      /**
       * ONE PROBE AT A TIME, AND AT MOST ONE PER WINDOW.
       *
       * Two callers now — the drain's preflight and {@link heartbeatTimer} — and the gate is what
       * keeps that from doubling the NOOPs on the wire: the second caller inside a window joins
       * the probe in flight or returns, and never opens a second one. At the defaults (a 15 s
       * poll against a 30 s window) the wire therefore carries fewer NOOPs than the preflight
       * alone did, not more.
       */
      const heartbeat = async (): Promise<void> => {
        const running = box.heartbeatInFlight;
        if (running !== null) { await running; return; }
        const last = box.heartbeatSettledAtMs;
        if (last !== null && scope.monotonic() - last < scope.heartbeatTimeoutMs) return;
        const run = probeConnection().finally(() => {
          box.heartbeatSettledAtMs = scope.monotonic();
          box.heartbeatInFlight = null;
        });
        box.heartbeatInFlight = run;
        await run;
      };

      /* RE-ARMED FROM THE PROBE'S OWN SETTLEMENT, never from a cycle — see
         {@link heartbeatTimer}. Unreferenced, so it does not hold the process open.

         THE HEAL FOLLOWS THE PROBE, exactly as it does in `syncUntilQuiet`, and leaving it out
         was half a fix: the timer stamped a hung link dead within the window and then nothing
         re-dialled it, because the re-dial rides a drain and the drain was the thing that was
         hung. Detection and heal both have to be independent of the cycle or neither is. */
      const armHeartbeat = (): void => {
        if (box.stopped) return;
        box.heartbeatTimer = setTimeout(() => {
          void heartbeat()
            .catch(() => undefined)
            .finally(() => {
              /* Re-armed before the heal: a re-dial drains inside itself, and its import is watched too. */
              armHeartbeat();
              void box.redialIfDead().catch(() => undefined);   // the ladder holds: the timer passes no `force`
            });
        }, scope.heartbeatTimeoutMs);
        box.heartbeatTimer.unref?.();
      };

      box.adapter = dialAdapter();
      /**
       * END THE LOGIN THE FORGOTTEN PASSWORD BOUGHT. Removing the row leaves an authenticated
       * socket open on a credential the person asked to be gone, and this engine outlives the
       * clear on every door that does not stop it. The login alone: the timers are
       * {@link purgeCredential}'s, which leaves the runtime dialling nothing.
       */
      const closeDialAfterSignOut = async (): Promise<void> => {
        await box.adapter.close().catch(() => { /* already going away */ });
      };
      const deadLetters = new DeadLetterLedger({
        holdAtCap: true, ...(scope.opened.storeWrites ? { storeWrites: () => scope.opened.storeWrites!() } : {}),
      });
      /* THE SET-ASIDE COUNT FROM THE FIRST MOMENT, not the first cycle: a relaunch into an outage or a
         missing password would otherwise say nothing while rows stand. Additive (`hydrate`), the read
         the first cycle makes anyway; a failed read leaves the count to that cycle. */
      void scope.repo.listMessageFailures(mb.id).then((rows) => { deadLetters.hydrate(rows); }, () => undefined);
      const syncDeps = {
        repo: scope.cycleRepo,
        /**
         * AN ACCESSOR, NOT A COPY — the same rule the runtime record below states for its
         * thirteen fields, and here it is load-bearing rather than tidy. A re-dial REPLACES the
         * adapter, and a `syncDeps` that had captured the old one would hand every cycle after
         * the first re-dial the connection that died: the drain would keep throwing `NoConnection`
         * over a healthy socket sitting one binding away.
         */
        get adapter() { return box.adapter; },
        accountId: scope.world.accountId, mailboxId: mb.id,
        // THE SYNC LOOP'S OWN DIAGNOSTICS, which this composition used to omit — see
        // `SidecarConfig.logger`. Spread here rather than assigned unconditionally so that an
        // install with no logger keeps the pre-existing shape (`log` absent, not `log: undefined`),
        // which is what `exactOptionalPropertyTypes` requires of an optional field.
        ...(config.logger === undefined ? {} : { log: config.logger }),
        // The same consent rule as the hosted worker: whose `Authentication-Results` this
        // mailbox may believe is a fact about the host THIS config dials — Gmail/Microsoft
        // resolve to their signing authserv-id, everything else to the empty set (demote nothing).
        // A fact about the host THIS mailbox dials — Gmail and Microsoft resolve to their signing
      // authserv-id, everything else to the empty set. Resolved from the process configuration it
      // would hand one mailbox's provider trust to another's mail.
      trustedAuthservIds: providerAuthservIds(box.mbImap.host),
        // UNMETERED STORAGE, typed — the free tier's limit is the user's own disk, and the field
        // is required precisely so this line has to exist rather than be inferred from absence.
        // (The assertion keeps the unique-symbol type from widening to `symbol` in this untyped
        // literal; it changes no value.)
        storageCap: UNMETERED_STORAGE_CAP as typeof UNMETERED_STORAGE_CAP,
        /* ONE LEDGER FOR THE RUNTIME'S LIFE, as the hosted worker holds one per attachment. Absent,
           the loop built a fresh one every cycle, so a failing message was always on its first
           attempt: never written off, its folder's cursor held for good and the mailbox stopped
           behind it. The durable half (`message_failures`) is hydrated into it each cycle. With the
           local backstop: no quarantine here bounds a defect that refuses every message. */
        deadLetters,
        /* THE ENGINE'S OWN BUILD, so a deterministic write-off (`mime_too_large`, `data_too_large`)
           is read again by the next build, the version arm of `claimMessageFailures`. Absent or
           the shell's `unknown`: the cycle's own `UNLABELLED_BUILD`, `dev` on every local door. */
        ...(scope.engineBuild === null ? {} : { buildVersion: scope.engineBuild }),
        // The blank repair's one mode, as this install was configured (`SidecarConfig.blankRepair`):
        // `off` and `dry` hold on this door as on the hosted worker's. Absent is apply.
        ...(config.blankRepair !== undefined ? { blankRepair: config.blankRepair } : {}),
      };
      box.firstSync = firstSync;
      box.clearSignInRefusal = clearSignInRefusal;
      box.redialWait = redialWait;
      box.forcedWait = forcedWait;
      box.networkWait = networkWait;
      box.assertSameConnection = assertSameConnection;
      box.jittered = jittered;
      box.climbTheLadder = climbTheLadder;
      box.noteLoginUnusable = noteLoginUnusable;
      box.adoptRowDial = adoptRowDial;
      box.claimOnCandidate = claimOnCandidate;
      box.rereadCredential = rereadCredential;
      box.adoptSeedConsent = adoptSeedConsent;
      box.pinPlaintextDial = pinPlaintextDial;
      box.dialAdapter = dialAdapter;
      box.noteConnectionDead = noteConnectionDead;
      box.noteCycleServed = noteCycleServed;
      box.noteStoreFaultDrain = noteStoreFaultDrain;
      box.noteCycleFailed = noteCycleFailed;
      box.noteFetchRefused = noteFetchRefused;
      box.heartbeat = heartbeat;
      box.armHeartbeat = armHeartbeat;
      box.closeDialAfterSignOut = closeDialAfterSignOut;
      box.deadLetters = deadLetters;
      box.syncDeps = syncDeps;
}
