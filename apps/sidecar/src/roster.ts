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

/** Why this install is not organizing a mailbox, when it is not. One answer per mailbox. */
export interface OrganizerState {
  organizing: boolean;
  /** The closed-set reason, mirrored onto that mailbox's `mailboxes` row. */
  reason: MailboxDisabledReason | null;
  /** The other organizer's display name, so the UI can say WHICH machine. */
  heldBy: string | null;
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

  // ── THE ENTRY POINTS ─────────────────────────────────────────────────────────────────────────
  /** Run this mailbox's serial queue. */
  serialize<T>(fn: () => Promise<T>): Promise<T>;
  /** Drain this mailbox until it reports no backlog; answers how many cycles ran. */
  syncUntilQuiet(maxCycles?: number): Promise<number>;
  /** Connect, ensure the tree if organizing, drain, then poll. Never throws for "no password". */
  start(): Promise<void>;
  /** Stop this mailbox's timer, wait for the in-flight cycle and close its login. Leaves the
   *  store alone — the store is the install's, not this row's. */
  detach(): Promise<void>;
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
