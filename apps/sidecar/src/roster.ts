/**
 * One runtime per mailbox. The standalone install used to serve one mailbox, and its running state
 * lived as thirteen `let`s in `createSidecar`'s closure (adapter, poll timer, serial queue, lease
 * nonce, stand-down and consent flags, the `ohmail/*` mark). With N mailboxes those become thirteen
 * fields of THIS record in a `Map<mailboxId, runtime>` — the hosted worker's own shape, so the two
 * hosts hold one runtime the same way. Per MAILBOX: the connection, lease claim, organizer role, poll
 * timer, cursors, credential. Per INSTALL (and NOT here): the store, account row, key ring, AI
 * settings, screening window, rules, tags, change-log sequence, launch session. The account-wide
 * maintenance passes (`bubbleUpPass`, `screenerAutoSuggestPass`, …) look per-mailbox and are NOT — their gates stay in the engine's scope.
 */

import type { ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { LeasePeekAnswer } from "@trafficflow/core/adapters/organizer-lease";
import type { SyncDeps } from "@trafficflow/worker/sync";
import type { OrganizerProfileSync } from "@trafficflow/worker/profile";
import type { MailboxDisabledReason } from "@trafficflow/db";
/* The name only — see {@link FirstSyncState}'s own header for why it is declared over there. */
import type { FirstSyncState } from "./first-sync.js";

export type { FirstSyncState };

/**
 * Whether this install can open ONE mailbox right now, and if not, why not. The shell renders it
 * as the difference between "you are connected", "enter your password" and "enter it again".
 *
 * It lives here rather than in `engine.ts` because it is a fact about a mailbox and not about the
 * install: with N rows there are N answers, and the engine re-exports this name so the one caller
 * that reads it over the bridge (`protocol.ts`) is unchanged.
 */
export type CredentialState =
  /** A password is available — from the store, or from the environment on a first run. */
  | "ready"
  /** No password anywhere. The shell asks for one; nothing is broken and nothing is lost. */
  | "absent"
  /**
   * A stored credential exists and THIS key cannot open it — a replaced keystore entry, a
   * retired key version, a corrupt envelope. Recoverable by re-entering the password, which
   * re-seals the row under the current key.
   */
  | "unreadable"
  /**
   * A stored credential exists and it belongs to A DIFFERENT SERVER than the one this resolution
   * is about. `credential-host.ts` holds the comparison and the whole argument for why it is
   * one-sided; `engine.ts`'s `resolveLogin` is where the two scopes (incoming, outgoing) are
   * told apart.
   */
  | "foreign-host";

/**
 * A STORED PASSWORD EXISTS AND THIS LAUNCH COULD NOT DIAL WITH IT — the outage nothing watched.
 *
 * `absent` is not one of these: nothing was stored, the mailbox never synced, and a person is
 * being asked for a password rather than told about an outage. These two are the opposite — the
 * mailbox WAS syncing, the row is intact, and this launch served nothing. One object rather than
 * a pair of fields so `confirmed` cannot stand without a state to be confirmed about.
 */
export interface CredentialBlock {
  /** Which non-ready state stopped the launch. */
  state: Extract<CredentialState, "unreadable" | "foreign-host">;
  /**
   * A SECOND, FRESH READ AGREED, so the advice ("sign in again") may be shown. A first failure
   * can be a provider that was not ready yet, and telling somebody to re-type a password that was
   * never the problem is asking for work that is not theirs.
   */
  confirmed: boolean;
}

/**
 * WHY THIS INSTALL CANNOT KEEP THIS MAILBOX'S SETTINGS DOCUMENT — the profile's half of
 * {@link CredentialBlock}'s shape, and deliberately the same shape.
 */
export interface ProfileBlock {
  /**
   * The refusal's `errorCode`, or `null` where the thrown value carried none. The same alphabet
   * `organizer_profile_write_failed` publishes, so the sentence a person is shown and the line a
   * maintainer reads name one fact rather than two.
   */
  code: string | null;
  /**
   * THE CONDITION HAS BEEN SEEN TWICE, or once with no working reading behind it. The credential
   * block's rule: a single refusal can be a provider that was not ready on one drain, and a
   * sentence raised on it is noise nobody can act on. Always `true` where the block exists at
   * all — the field is here so the shape matches its sibling and a later softer state has
   * somewhere to live.
   */
  confirmed: boolean;
}

  /**
   * Whether this install can reach one mailbox's server right now, and what its first sync
   * produced. Not on {@link OrganizerState}: "who organizes this mailbox" is a fact about the
   * LEASE and survives an outage untouched, while "can I reach it" is about a SOCKET. In memory
   * only — a dead connection does not survive a restart, so a column would be a durable statement
   * about a transient fact. {@link firstSync} rides here because both answer "what is this link
   * doing for my mail", both are read in ONE pass by every surface, and a second record would be a
   * second clock that could disagree with itself.
   */
export interface MailboxConnectionState {
  /** False from the first observation of death until a re-dial completes. */
  reachable: boolean;
  /**
   * When it was FIRST observed dead in the current outage, or null while reachable.
   *
   * First and never latest: this is what the settings row renders as "unreachable since", and a
   * clock restarted by each failed re-dial would report a two-hour outage as seconds old.
   */
  unreachableSince: Date | null;
  /**
   * THE SERVER ANSWERED AND REFUSED THE SIGN-IN.
   *
   * Separate from `reachable`, because they are different facts with different remedies and the
   * pane must not confuse them: an unreachable server is retried and heals on its own; a refused
   * sign-in is not retried at all, and stays until a person changes the password or reconnects
   * the account. Telling somebody to check their connection when the server has already answered
   * and said no sends them to look in the wrong place.
   */
  signInRefused: boolean;
  /**
   * THE STORED PASSWORD COULD NOT BE USED — see {@link CredentialBlock}, `null` when it could.
   *
   * Beside `signInRefused` and not folded into it: no server has answered this launch at all, so
   * "the mail server refused the sign-in" is a true sentence about the wrong thing. It rides the
   * same record because a surface reads both in one pass, and because both are reasons a mailbox
   * that looks connected is moving no mail.
   */
  credentialBlocked: CredentialBlock | null;
  /**
   * THIS MAILBOX'S SETTINGS DOCUMENT COULD NOT BE READ OR WRITTEN — see {@link ProfileBlock},
   * `null` while it is being maintained.
   *
   * The same family as {@link credentialBlocked} and here for the same reason: it is a reason a
   * mailbox that looks connected is not being organized the way its person asked. Measured on
   * the 0.18.0 release candidate — a claimed mailbox whose `ohmail/_meta` refused every read, drains succeeding
   * every sixteen seconds, and the row reading Up to date for the life of the install. The drain
   * cannot see this: it answers "is mail coming down", and this answers "can this install read
   * the rules it is supposed to apply".
   */
  profileBlocked: ProfileBlock | null;
  /**
   * What this mailbox's first sync produced — see {@link FirstSyncState}. Derived from the
   * engine's own facts (the import stamp its drain writes, and whether the mirror holds anything
   * for this mailbox), never from a clock: "it has been a while" is not evidence that a mailbox
   * cannot be read, and a mailbox that later reads becomes `finished`.
   */
  firstSync: FirstSyncState;
}

/** Why this install is not organizing a mailbox, when it is not. One answer per mailbox. */
export interface OrganizerState {
  organizing: boolean;
  /** The closed-set reason, mirrored onto that mailbox's `mailboxes` row. */
  reason: MailboxDisabledReason | null;
  /** The other organizer's display name, so the UI can say WHICH machine. */
  heldBy: string | null;
  /**
   * Since when the lease could not be read at all — ISO 8601, or `null` when it reads fine. On the
   * hosted side an unreadable lease is visible within about four minutes (exempt from the sync
   * counter by class, the mailbox detaches and re-attaches, the block written to the row). On a LOCAL
   * install the same condition was a LOG LINE and nothing else, and nobody reads a desktop log — so a
   * folder anyone with append rights can fill would leave a person's mail quietly unorganized with an
   * ordinary connected state, the "reliability feature that renders as its own healthy state" shape.
   * Set where the lease read throws, cleared when it resolves; the shell renders `blocked_lease_unreadable`.
   */
  unreadableSince: string | null;
  /**
   * THE PERSON'S STOP, STILL STANDING ON THE ROW — ISO 8601, or `null` where none is. The gate
   * already re-reads `release_requested_at` every pass; this is that read projected so a caller
   * needs no second one. It is the only thing separating a stop the mailbox honoured from one it
   * did not: {@link organizing} answers what THIS PASS may arrange, and a pass asked to release
   * arranges nothing either way — so `organizing: false` was read as "the mailbox was let go" and
   * a refused stop took the notification down over a standing claim. `null` once a pass's
   * compare-and-set has spent the request; carried, never cleared, by a pass that did not read the
   * row ({@link unreadableSince}'s rule). The name is the ROW's and the DTO's.
   */
  releaseRequestedAt: string | null;
  /**
   * IS THIS MAILBOX CLAIMED BY THIS INSTALL — the instruction, not the pass's progress.
   *
   * {@link organizing} flips only once the gate has read the lease AND taken its permit — one IMAP
   * round trip after this install's claim is already standing in `ohmail/_meta`. In that window a
   * reader cannot tell a mailbox just claimed from one nobody consented to, and the phone's
   * background arm read the second. This is the third state — consent recorded and the row saying
   * organizer — set where the gate becomes entitled to the lease and cleared when the claim leaves.
   */
  claimed: boolean;
}

/**
 * The parts of `SyncDeps` a runtime OWNS for the life of its attachment.
 *
 * The six omitted fields are the ones resolved fresh at every cycle edge and must never be frozen
 * here: the ROLE (the gate's answer this pass), the CLASSIFIER (withheld after faults), the three
 * SCREENING inputs (read once per drain, so an edit in Settings takes effect on the next poll) and
 * the import-decision hold (evaluated from the folder each cycle). Anything cached here would be
 * a per-launch answer to a per-cycle question.
 */
export type RuntimeSyncDeps = Omit<
  SyncDeps,
  "role" | "classifier" | "importDecisionOpen" | "ohboxPolicy" | "ohboxBar" | "screeningCutoff"
>;

/**
 * ONE MAILBOX, RUNNING — the thirteen closure fields, plus the handful of entry points that let a
 * caller holding the map do to one mailbox what `createSidecar` used to do to its only one.
 *
 * The state fields are mutable on purpose. They are what the gate WRITES: a stand-down sets
 * `organizer` and `priorStandDown`, a promotion clears them, a lease read sets `leaseNonce`.
 * Freezing them and rebuilding the record would lose the identity the serial queue and the timer
 * are attached to.
 */
export interface LocalMailboxRuntime {
  /** The `mailboxes` row this runtime serves. Immutable for its whole life: a re-point is a
   *  detach and a fresh attach, never a field write, because the adapter, the claim, the cursors
   *  and the credential all hang off this id. */
  readonly mailboxId: string;
  /** The address as the row holds it — for the seed comparison and for log-free identification. */
  readonly address: string;
  /**
   * What THIS mailbox dials, resolved from its own `imap` credential row's `meta` rather than
   * from the process's environment.
   *
   * This is the field that ends the one-mailbox assumption. `OHMAIL_IMAP_*` used to be the
   * configuration of the mailbox; it is now the SEED of the first one, and every row — the seed
   * included, once its `meta` is backfilled — dials from what its own credential was proved
   * against. It is the same source the hosted worker uses and the same one this door already used
   * for attachment fetches, so a second mailbox is not a second convention.
   */
  readonly imap: Omit<ImapConfig, "auth"> & { auth: { user: string; pass?: string } };

  // ── THE THIRTEEN ─────────────────────────────────────────────────────────────────────────────
  /** The connected IMAP adapter for this mailbox. One login per row. */
  adapter: MailboxAdapter;
  /** The per-cycle dependency bag, minus what {@link RuntimeSyncDeps} says is resolved per cycle. */
  syncDeps: RuntimeSyncDeps;
  /** This mailbox's poll timer. Its own, so one mailbox's drain never delays another's poll. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The serial queue's tail — a poll must never start a cycle while one is running for THIS
   *  mailbox. Drains of DIFFERENT mailboxes may overlap: the store serves the window during a
   *  drain already, and PGlite's driver serializes transactions on its own mutex. */
  tail: Promise<unknown>;
  /** Set when this mailbox is gone (removed, or discovered removed mid-launch) — the two states
   *  that still mean "stop syncing entirely". A reader is NOT stopped. */
  stopped: boolean;
  /** The stand-down this process remembers for this mailbox. What keeps a lapsed Cloud
   *  subscription from auto-resuming the desktop across a poll or a relaunch. */
  priorStandDown: string | null;
  /** What the window reports for this mailbox — the row's answer, not the gate's optimism. */
  organizer: OrganizerState;
  /** A human asked for this machine to organize THIS mailbox, once. Spent when it succeeds. */
  takeoverAuthorized: boolean;
  /** The exact stamp this pass read, so a stand-down clears that one and not a press that landed
   *  while the lease was being read. */
  observedTakeoverAt: Date | null;
  /** `organize_consented_at` as this mailbox's row holds it, re-read by the gate every pass. */
  consented: boolean;
  /** Has this process created the `ohmail/*` tree in THIS mailbox yet? Never reset — a demotion
   *  does not remove folders, and a re-promotion has nothing to re-create. */
  foldersEnsured: boolean;
  /** In memory only — the clone defence. Forgetting it on restart is what makes own-role
   *  resumption work. */
  leaseNonce: string | null;
  /** The portable organizer profile's write-behind, per mailbox because the document lives in
   *  that mailbox's own `ohmail/_meta`. */
  profileSync: OrganizerProfileSync;

  // ── THE FOURTEENTH ───────────────────────────────────────────────────────────────────────────
  /**
   * Can this install reach this mailbox's server right now — see {@link MailboxConnectionState}.
   * READ-ONLY, the difference from the thirteen above: those are what the GATE writes, this is what
   * the CONNECTION does, and the only writers are the adapter's own death report and the bound over
   * failing cycles. A setter would let a caller assert a socket is healthy, the one thing no caller
   * can know. An accessor rather than a copy for the same reason the thirteen are: the pane reads it a
   * poll after the gate wrote it, and a frozen record would render a two-hour-old outage as current.
   */
  readonly connection: MailboxConnectionState;

  // ── THE ENTRY POINTS ─────────────────────────────────────────────────────────────────────────
  /** Run this mailbox's serial queue. */
  serialize<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Drain this mailbox until it reports no backlog; answers how many cycles ran.
   *
   * `force` skips the re-dial backoff WAIT and nothing else — it is a person pressing "Sync
   * now", carried from the resync route. The poll passes nothing, so the ladder still holds
   * for it; see `redialIfDead` in `engine.ts` for what a press may and may not outrank.
   */
  syncUntilQuiet(maxCycles?: number, opts?: { force?: boolean }): Promise<number>;
  /** Connect, ensure the tree if organizing, drain, then poll. Never throws for "no password". */
  start(): Promise<void>;
  /**
   * Stop taking work and wait out the pass already running — WITHOUT closing the login.
   *
   * The half of a stop that has to happen before a caller writes anything about this mailbox. A
   * removal tombstones the row and takes the mail off this machine; a pass parked in a server
   * call resumes after that and commits its messages into a mailbox that no longer exists, so the
   * mail stays and the window is told it arrived after the receipt saying the mailbox is gone.
   * The login stays open because the claim release needs it, and {@link detach} closes it
   * afterwards on the same budget — a removal costs one drain interval, not two.
   */
  quiesce(): Promise<void>;
  /**
   * Take the mailbox back off hold — for a caller that quiesced and then did NOT remove it.
   *
   * Only ever undoes a hold {@link quiesce} itself placed: a runtime that was already stopped for
   * its own reason stays stopped. Without it a refused removal left a mailbox the person still has
   * with no poll timer, reporting itself reachable.
   */
  unquiesce(): void;
  /** Stop this mailbox's timer, wait for the in-flight cycle and close its login. Leaves the
   *  store alone — the store is the install's, not this row's. */
  detach(): Promise<void>;
  /**
   * Re-dial now if this mailbox's connection is dead — the foreground wake, exposed. The engine
   * already re-dials a dead connection at the top of its poll, the right cadence for a desktop whose
   * socket dies rarely, and the wrong one for a phone whose socket dies on EVERY background: coming
   * back, the phone would show "organizing" and file nothing until the next poll tick's re-dial
   * finished (up to 120 s, eight cycles). So the same function gets a caller. It does NOT drain and
   * does NOT organize — it restores a connection and lets the ordinary gated cycle decide (the
   * learn-then-act rule; a wake that drained would organize over an unread lease, the two-organizers
   * failure). Idempotent and cheap: a live connection, stopped runtime or in-flight re-dial returns.
   */
  redial(): Promise<void>;
  /**
   * Give the claim back and stay the organizer of record — the phone's leave-the-app hand-back.
   * Neither existing act: `detach()` gives the claim back and then closes the login and the timer
   * (this mailbox stops being served at all — right for a shutdown, wrong for a pocketed phone),
   * and the release ROUTE removes the claim and writes the row to `reader` (a reader never re-enters
   * the gate without a human press — right for "stop organizing here", wrong for a pocketed iPhone).
   * So this removes the CLAIM and writes no row: the next gated cycle reads the lease and either
   * claims it back or stands down, which makes the resume automatic and never displaces whoever took
   * it. Answers {@link releaseMailboxClaim}'s three outcomes unflattened (a count, `0`, or `null`).
   */
  handBack(): Promise<number | null>;
  /**
   * TAKE IT BACK IF NOBODY ELSE HAS IT — clears the hand-back and runs one gated cycle.
   *
   * The gate claims a free mailbox and stands this install down against a holder, so a resume can
   * never displace anybody: that is the press's job and this is not a press. Answers how many
   * cycles ran; `0` is a cycle that could not be served, and nothing may then report the mailbox
   * as taken back.
   */
  resume(): Promise<number>;
  /**
   * LOOK AT `ohmail/_meta` NOW, AND ANSWER IN THREE WORDS — free, held-by, or unreadable.
   *
   * The APPEND-less read this runtime's own poll makes, exposed so a DOOR can ask it rather than
   * guess off the holder columns: `organizer_state` is `held`, `stopped` or NULL, and NULL means
   * "we have not looked". It never throws and never writes — `unreadable` is the refusal, in a
   * value. NOT inside the serial queue: `handBack` takes it because it WRITES, while this is a
   * SELECT and a FETCH imapflow already queues, and a press made to wait out a drain hangs.
   */
  peekOrganizer(): Promise<LeasePeekAnswer>;
  /** Can this install open this mailbox right now? Read fresh from the store on every call. */
  credentialState(): Promise<CredentialState>;
  /** Forget this mailbox's sealed password. Answers whether there was one to forget. */
  forgetStoredLogin(): Promise<boolean>;
}

/**
 * The roster: every mailbox this install currently runs, keyed by row id. A class rather than a bare
 * `Map` for one reason — the ORDER: `organizerStates()` and the shell's `ready.mailboxId` fallback
 * both mean "oldest first", and a `Map` preserves insertion order only while every insertion goes
 * through one place that inserts in `created_at` order, which making that place a method keeps true.
 * NO INTERVAL, unlike the worker: the hosted worker re-reads its roster on a timer because OTHER
 * processes write its `mailboxes` table, but here the only writers are this engine's own routes, so
 * attach and detach are EVENTS (`POST /local/mailboxes`, `DELETE /local/mailboxes/:id`, the boot's
 * one read) and a poll would be this process asking itself something it already knows.
 */
export class LocalRoster {
  private readonly byId = new Map<string, LocalMailboxRuntime>();

  /** Insertion order IS `created_at` order, because the boot inserts in it and every later
   *  insertion is a newly created row. See the class header. */
  add(rt: LocalMailboxRuntime): void {
    this.byId.set(rt.mailboxId, rt);
  }

  get(mailboxId: string): LocalMailboxRuntime | undefined {
    return this.byId.get(mailboxId);
  }

  has(mailboxId: string): boolean {
    return this.byId.has(mailboxId);
  }

  delete(mailboxId: string): boolean {
    return this.byId.delete(mailboxId);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Oldest first. */
  all(): readonly LocalMailboxRuntime[] {
    return [...this.byId.values()];
  }

  /**
   * The runtime the shell's single-mailbox surfaces answer for: the row matching the seed
   * address, else the oldest live row, else nothing.
   *
   * `EngineStatus.address` MEANS the seed address, and `ready.mailboxId` is this runtime's id.
   * The fallback exists because the seed can be REMOVED while others remain — `config.json` then
   * names an address no row has, and answering nothing would leave a working install reporting
   * itself unconfigured.
   */
  seed(seedAddress: string): LocalMailboxRuntime | undefined {
    const wanted = seedAddress.trim().toLowerCase();
    if (wanted) {
      for (const rt of this.byId.values()) {
        if (rt.address.trim().toLowerCase() === wanted) return rt;
      }
    }
    return this.byId.values().next().value;
  }
}
