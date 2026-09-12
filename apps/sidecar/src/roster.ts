/**
 * ═══ ONE RUNTIME PER MAILBOX ═══════════════════════════════════════════════════════════════════
 *
 * The standalone install used to serve exactly one mailbox, and the whole of that mailbox's
 * running state lived as thirteen `let`s in `createSidecar`'s closure — the adapter, the poll
 * timer, the serial queue, the lease nonce, whether this install had been stood down, whether it
 * had been consented to, whether its `ohmail/*` tree had been made. One mailbox, one closure, and
 * the two were the same thing.
 *
 * With N mailboxes those thirteen become thirteen fields of THIS record, held in a
 * `Map<mailboxId, runtime>`. That is the hosted sync worker's own shape (`apps/worker/src/index.ts`
 * keeps a `MailboxRuntime` per attached mailbox in exactly such a map), and taking it here rather
 * than inventing a second arrangement is the point: the two hosts already run one pipeline, and
 * they should hold one runtime the same way.
 *
 * ── WHAT IS PER-MAILBOX AND WHAT IS NOT, BECAUSE THE ANSWER IS NOT "EVERYTHING" ────────────────
 *
 * Per MAILBOX: the IMAP connection, the lease claim, the organizer role, the poll timer, the
 * folder cursors, the credential. Each of those is a fact about one server and one login.
 *
 * Per INSTALL (and therefore NOT here): the store, the account row, the key ring, the AI settings,
 * the screening window, the rules, the tags, the change-log sequence and the launch session.
 * `local-mirror.ts`'s header already names the account-scoped tables; the window is
 * `account_settings`; the AI file is "a property of the install". A second copy of any of those
 * per mailbox would be two answers to a question the install only asks once.
 *
 * The maintenance passes are the case worth stating, because they LOOK per-mailbox and are not.
 * `bubbleUpPass`, `screenerAutoSuggestPass`, `runSenderNameBackfill`, `threadJoinHealPass` and
 * `inboundQuietPass` all take an ACCOUNT and no mailbox. Their gates and cursors therefore stay in
 * the engine's own scope rather than moving here: two runtimes draining share one six-hour heal
 * gate and one name-backfill walk, which is one pass per install per interval — where a copy per
 * runtime would run the same account-wide scan N times per poll for the same rows.
 */

import type { ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { SyncDeps } from "@trafficflow/worker/sync";
import type { OrganizerProfileSync } from "@trafficflow/worker/profile";
import type { MailboxDisabledReason } from "@trafficflow/db";

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
 * WHETHER THIS INSTALL CAN REACH ONE MAILBOX'S SERVER RIGHT NOW.
 *
 * It is not on {@link OrganizerState} and must not be folded into it, because the two answer
 * different questions and the pane needs both. "Who organizes this mailbox" is a fact about the
 * LEASE and survives an outage untouched — this install is still the organizer of a mailbox it
 * cannot currently reach, and saying otherwise would invite a person to take a mailbox back that
 * was never taken from them. "Can I reach it" is a fact about a SOCKET, and it is the one that
 * decides whether "On this machine" is presently true in any useful sense.
 *
 * IN MEMORY ONLY, deliberately. A dead connection does not survive a restart — a relaunch dials
 * a fresh one — so a column recording it would be a durable statement about a transient fact,
 * wrong from the first boot after every outage.
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
}

/** Why this install is not organizing a mailbox, when it is not. One answer per mailbox. */
export interface OrganizerState {
  organizing: boolean;
  /** The closed-set reason, mirrored onto that mailbox's `mailboxes` row. */
  reason: MailboxDisabledReason | null;
  /** The other organizer's display name, so the UI can say WHICH machine. */
  heldBy: string | null;
  /**
   * SINCE WHEN THE LEASE COULD NOT BE READ AT ALL — ISO 8601, or `null` when it reads fine.
   *
   * On the hosted side an unreadable lease is already visible within about four minutes: the
   * failure is exempt from the sync counter BY CLASS, the mailbox detaches, re-attaches, and the
   * block is written to the row where the web app renders it.
   *
   * On a LOCAL install the same condition was a LOG LINE and nothing else. Nobody reads a desktop
   * log. So a folder anyone with append rights can fill would leave a person's mail quietly
   * unorganized with the app showing an ordinary connected state — which is the "reliability
   * feature that renders as its own healthy state" shape this codebase has been bitten by before.
   *
   * Set where the lease read throws, cleared the moment it resolves. The shell renders the
   * `blocked_lease_unreadable` string that already exists in both catalogues.
   */
  unreadableSince: string | null;
  /**
   * THE PERSON'S STOP, STILL STANDING ON THE ROW — ISO 8601, or `null` where none is.
   *
   * The gate already re-reads `release_requested_at` every pass, and this is that read projected
   * so a caller can have it without a second one. It is the only thing that separates a stop the
   * mailbox honoured from one it did not: {@link organizing} answers what THIS PASS may arrange,
   * and a pass asked to release arranges nothing and renews nothing whether or not the claim
   * actually left `ohmail/_meta` — so `organizing: false` was read by the phone's own adapter as
   * "the mailbox was let go", and a stop the server refused took the notification down over an
   * install whose claim still stood.
   *
   * `null` once a pass's compare-and-set has spent the request, which is the same moment the row
   * records the release. Carried, never cleared, by a pass that did not read the row — the rule
   * {@link unreadableSince} holds to, and for its reason.
   *
   * The name is the ROW's and the DTO's (`releaseRequestedAt`): the desktop already renders
   * "Stopping" from exactly this fact, and a second spelling of it here is how two surfaces come
   * to disagree about whether a mailbox is being let go.
   */
  releaseRequestedAt: string | null;
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
   *
   * READ-ONLY, and that is the difference from the thirteen above. Those are what the GATE
   * writes; this is what the CONNECTION does, and the only writers are the adapter's own death
   * report and the bound over failing cycles. A setter would let a caller assert a socket is
   * healthy, which is the one thing no caller can know.
   *
   * An accessor rather than a copy for the same reason the thirteen are: the pane reads it a poll
   * after the gate wrote it, and a frozen record would render a two-hour-old outage as current.
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
  /** Stop this mailbox's timer, wait for the in-flight cycle and close its login. Leaves the
   *  store alone — the store is the install's, not this row's. */
  detach(): Promise<void>;
  /**
   * RE-DIAL NOW IF THIS MAILBOX'S CONNECTION IS DEAD — the foreground wake, exposed.
   *
   * The engine already re-dials a dead connection, at the top of its own poll. That is the right
   * cadence for a desktop, whose socket dies rarely. It is the wrong one for a phone, where the
   * socket dies on EVERY background: coming back to the foreground, the phone would show
   * "organizing" and file nothing until the next poll tick came round and the re-dial inside it
   * finished — measured on the desktop's own bound at up to 120 s and eight cycles.
   *
   * So the same function gets a caller. This does NOT drain and does NOT organize: it restores a
   * connection and lets the ordinary gated cycle decide what may happen on it, which is the
   * learn-then-act rule. A wake that called the drain instead would be organizing over a
   * connection whose lease it had never read — the two-organizers failure, reached through the
   * front door.
   *
   * Idempotent and cheap: a live connection, a stopped runtime, a re-dial already in flight, a
   * mailbox with no usable password, a refused sign-in, or a backoff window not yet elapsed all
   * return without doing anything.
   */
  redial(): Promise<void>;
  /**
   * GIVE THE CLAIM BACK AND STAY THE ORGANIZER OF RECORD — the phone's leave-the-app hand-back.
   *
   * Neither of the two acts that already exist. `detach()` closes the login and leaves the claim
   * standing in `ohmail/_meta` to age out, so a desktop asked to take the mailbox stands itself
   * down against a claim nobody is honouring for the length of the staleness window. The release
   * ROUTE removes the claim and writes the row to `reader`, and a reader never re-enters the gate
   * without a human press — which is right for "stop organizing here" and wrong for an iPhone
   * that is being put in a pocket.
   *
   * So this removes the CLAIM and writes no row: the next gated cycle reads the lease and either
   * claims it back (nobody took it) or stands down (somebody did). That is what makes the
   * resume automatic and what keeps it from ever displacing whoever took the mailbox meanwhile.
   *
   * Answers {@link releaseMailboxClaim}'s own three outcomes, unflattened: a count of this
   * install's records removed, `0` for a complete read that found none of ours, and `null` for
   * "could not look" — where this install may still hold the claim and the caller must not say
   * the mailbox was handed back.
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
  /** Can this install open this mailbox right now? Read fresh from the store on every call. */
  credentialState(): Promise<CredentialState>;
  /** Forget this mailbox's sealed password. Answers whether there was one to forget. */
  forgetStoredLogin(): Promise<boolean>;
}

/**
 * The roster: every mailbox this install currently runs, keyed by row id.
 *
 * A class rather than a bare `Map` for one reason — the ORDER. `organizerStates()` and the shell's
 * `ready.mailboxId` fallback both mean "oldest first", and a `Map` preserves insertion order, so
 * the guarantee holds only while every insertion goes through one place that inserts in
 * `created_at` order. Making that one place a method is what keeps it true; a bare map would put
 * the ordering contract in each caller's head.
 *
 * ── NO INTERVAL, AND THAT IS A DIFFERENCE FROM THE WORKER ─────────────────────────────────────
 *
 * The hosted worker re-reads its roster on a timer because OTHER processes write its `mailboxes`
 * table — the API adds one, an operator disables one, and the worker has no way to be told. On
 * this door the only writers of `mailboxes` are this engine's own routes, so attach and detach are
 * EVENTS (`POST /local/mailboxes`, `DELETE /local/mailboxes/:id`, and the boot's one read) and a
 * poll would be this process asking itself a question it already knows the answer to.
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
