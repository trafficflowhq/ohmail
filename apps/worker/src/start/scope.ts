import type { KeyProvider, Logger, MicrosoftClientCredentials, MicrosoftClientKind, OAuthTokenProvider } from "@trafficflow/core";
import type { SignatureCheck } from "@trafficflow/core/adapters/dkim";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { OrganizerIntent } from "@trafficflow/core/adapters/organizer-lease";
import type { EntitlementsPort, OrganizerRole, RefundObligationPort } from "@trafficflow/db";
import type {
  AlertHeartbeat, AlertReaders, AlertSink, AttachmentStagingStorage, ChangeWakeFanout, DeliveryStreak,
  HeartbeatLogMemory, LastResortState,
} from "@trafficflow/db/cloud";
import type { ClassifierCircuit } from "../ai-circuit.js";
import type { AiUsageBuffer } from "../ai-usage.js";
import type { ApiCronHandle } from "../api-cron.js";
import type { AttachPool, AttachTicket } from "../attach-pool.js";
import type { AwayReplySweep } from "../away-reply-sweep.js";
import type { AiUsageRelay, WorkerConfig } from "../config.js";
import type { DialHostGuard } from "../dial-host-guard.js";
import type { DegradedCauses, UnservedBreakdown } from "../health.js";
import type { LeaderLock, LockLostError } from "../leader-lock.js";
import type { OrganizerWriteAuthority } from "@ohmail/organizer/lease";
import type {
  EnabledMailbox, LeaderFence, MailboxErrorPhase, MailboxSelection, MailboxSyncBlockReason, ParkedAccountsReader,
} from "../mailboxes.js";
import type { PlatformSignalPollHandle } from "../platform-signal-poll.js";
import type { SweepClearance } from "@ohmail/organizer/profile";
import type { RunningPushWake } from "../push-wake.js";
import type { ImpersonationWalk } from "@ohmail/organizer/screener-impersonation";
import type { StorageCapResolver } from "../storage-cap.js";
import type { SyncKickBell } from "../sync-kick.js";
import type { SyncDeps } from "@ohmail/organizer/sync";
import type { TailOrigin } from "../tail-stage.js";
import type { ThreadJoinHealWalk } from "../thread-join-heal-walk.js";
import type { MailboxRuntime, Quarantine } from "../index.js";
import type { WorkerBinding } from "./bind.js";
import type { CalendarRunner } from "./calendar.js";

/**
 * Mailboxes on the duty that this process is NOT SERVING, and since when (mail 0029). They were
 * bare `Set<string>`s, and a measured half-hour silence lived in that: a membership test can say
 * "not served" but not "for how long", so no catch arm could decide whether the state had lasted
 * long enough to write down, and every arm settled for a log line. `since` lets ONE place decide.
 * `reason` is nullable: `null` means "accounted for, but the ROW ALREADY EXPLAINS ITSELF" — the
 * stand-down case only, where `mayOrganize` returning false already wrote `status='disabled'` plus
 * `disabled_reason` through `markMailboxStoodDown`, which CLEARS these two columns; writing
 * `lease_unreadable` on top would be this pass contradicting itself with a worse answer.
 */
export interface SyncBlock {
  /** `Date.now()` when this process FIRST observed this block. Never moved by a re-observation. */
  since: number;
  /** What to write on the row, or `null` when the row already says something better. */
  reason: MailboxSyncBlockReason | null;
}

export interface TailWalk {
  /** The shard's enabled mailboxes and their accounts, read once when the walk began. */
  mailboxes: readonly EnabledMailbox[];
  accounts: readonly string[];
  suggestedAccounts: Set<string>;
  /** Index into `TAIL_SECTIONS`, and the accounts that section walks once entered (null: not yet). */
  section: number;
  list: readonly string[] | null;
  index: number;
  rotationMs: number;
  /** Due turns the rotation before this walk gave — see `admitDue`. */
  dueRevisits: number;
  startedAt: number;
  workMs: number;
  turns: number;
  sectionMs: number[];
}

/**
 * WHAT THE WORKER'S START FUNCTION SHARES BETWEEN ITS SECTIONS: one object, made at the top of
 * `startWorkerWithLock` (`../index.ts`) and handed to each section of this folder.
 *
 * A field is one of three things. A setting or port the head resolved once: set where the head
 * ends and never again. A function or table a section owns: set where that section ends, so
 * nothing reaches it before the section ran. Or a variable that changes while the worker runs:
 * those are marked `changes`, they are everything the sections know about each other's progress,
 * and each is set where the start function used to declare it.
 *
 * In declaration order, under the part of the start function each name comes from.
 */
export interface WorkerScope {
  /* ── The head: the settings as read, the ports, and what the process remembers about itself ── */
  config: WorkerConfig;
  lock: LeaderLock;
  /** The pool's view that names no account: the roster's reads and what runs for no account (`start/bind.ts`). */
  roster: WorkerBinding["roster"];
  /** One account's handle and its repository: everything done for one mailbox or one account (`start/bind.ts`). */
  forAccount: WorkerBinding["forAccount"];
  /** Forget every account's pair; the roster's load calls it, so handles last from one reading of the roster to the next. */
  forgetAccounts: WorkerBinding["forgetAccounts"];
  runtimes: Map<string, MailboxRuntime>;
  gapClearances: Map<string, SweepClearance>;
  attachPoolRef: AttachPool | null;   // changes
  stopTimers: (() => void) | null;   // changes
  keyProvider: KeyProvider;
  oauthTokenProvider: OAuthTokenProvider;
  /** Microsoft's registration for a door, resolved at the moment of a trade: the mail's and the calendar's one reader of it. */
  msRegistration: (want: MicrosoftClientKind) => Promise<MicrosoftClientCredentials>;
  shards: number;
  shardIndex: number;
  maxMailboxes: number;
  cycleLanes: number;
  heavyLanes: number;
  heavyTurnMs: number;
  sharedAccountTurnMs: number;
  rosterIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxSyncFailures: number;
  syncBlockGraceMs: number;
  leaseUnavailableDetachMs: number;
  selection: MailboxSelection;
  makeAdapter: NonNullable<WorkerConfig["adapterFactory"]>;
  dialHostGuard: DialHostGuard;
  environment: string;
  startedAt: Date;
  log: Logger;
  leaderToken: string;
  fence: LeaderFence;
  alertSinks: AlertSink[];
  alertDeliveryStreak: DeliveryStreak;
  alertLastResort: LastResortState;
  alertHeartbeat: AlertHeartbeat;
  alertHeartbeatLogged: HeartbeatLogMemory;
  stopped: boolean;   // changes
  lockLost: boolean;   // changes
  lastCycleAt: Date | null;   // changes
  lastRotationEndAt: number | null;   // changes
  lastTurnEndAt: number | null;   // changes
  visitStarts: Map<string, number>;
  lastRotationMs: number | null;   // changes
  lastDueRevisits: number;   // changes
  lastTailMs: number | null;   // changes
  dutyAccounts: string[];   // changes
  dutyMailboxes: readonly EnabledMailbox[];   // changes
  maintenanceDue: () => boolean;
  stagingStorage: AttachmentStagingStorage | null;
  lastBubbleUpAt: number;   // changes
  correspondentRetroAt: Map<string, number>;
  actAdmissionsRetired: Set<string>;
  actAdmissionCursor: Map<string, string>;
  goneLettersTidied: Set<string>;
  joinHealWalk: ThreadJoinHealWalk;
  lastInboundQuietAt: number;   // changes
  awayReplySweep: AwayReplySweep;
  lastAwayReplySweepAt: number;   // changes
  suggestOwedHints: Set<string>;
  impersonationSettled: Map<string, string>;
  impersonationWalks: Map<string, ImpersonationWalk>;
  noteScreenerHold: (accountId: string) => void;
  booted: boolean;   // changes
  firstBeatPending: boolean;   // changes
  heartbeatAt: number | null;
  claimed: boolean;   // changes
  expected: number;   // changes
  truncated: number;   // changes
  dutyGap: boolean;   // changes
  servedIds: readonly string[];   // changes
  dbFaultSince: number | null;   // changes
  dbFaults: number;   // changes
  quarantine: Map<string, Quarantine>;
  awaitingCreds: Map<string, SyncBlock>;
  leaseBlocked: Map<string, SyncBlock>;
  capDropped: Map<string, SyncBlock>;
  readLimited: Map<string, SyncBlock>;
  parkedBlocked: Map<string, SyncBlock>;
  closureDropped: Set<string>;

  /* ── start/faults.ts ── */
  noteBlock: (into: Map<string, SyncBlock>, mailboxId: string, reason: MailboxSyncBlockReason | null) => void;
  announced: { cap: string; creds: Set<string> };
  smtpSizeAttempted: Set<string>;
  noteDatabaseFault: (err: unknown, at?: { mailboxId?: string; accountId?: string }) => void;
  noteIfSharedDatabaseFault: (err: unknown, mb?: { mailboxId: string; accountId: string }) => void;
  runTailStage: (op: string, origin: TailOrigin, pass: () => Promise<unknown>, failed: (err: unknown) => void) => Promise<void>;
  tailFaultNote: (op: string) => (err: unknown) => void;
  clearDatabaseFault: () => void;

  /* ── start/queue.ts ── */
  rosterPending: boolean;   // changes
  rosterPendingSince: number;   // changes
  rosterQueued: boolean;   // changes
  tail: Promise<unknown>;   // changes
  serialize: <T>(fn: () => Promise<T>) => Promise<T>;
  drain: () => Promise<void>;
  laneBusy: Set<string>;
  deferredLeaves: Array<{ rt: MailboxRuntime; release: boolean; reason: string }>;
  attachDeadlineMs: number;
  attachPool: AttachPool;
  wakeAccount: (accountId: string) => void;
  noteWake: (mailboxId: string) => void;
  wakeSignal: Promise<void>;   // changes
  fireWake: () => void;   // changes
  nudgeCycle: () => void;
  backoffFor: (attempts: number) => number;

  /* ── The head, continued: the plan, the spend and the lease identity ── */
  spend: EntitlementsPort | undefined;
  obligations: RefundObligationPort | undefined;
  usageRelay: AiUsageRelay | undefined;
  usageBuffer: AiUsageBuffer | undefined;
  alertReaders: AlertReaders;
  parkedAccountsReader: ParkedAccountsReader | null;
  classifierCircuit: ClassifierCircuit | undefined;
  aiFor: (mailboxId: string, accountId: string) => Pick<SyncDeps, "classifier" | "credits" | "readModelConsent" | "consentRefunds">;
  storageCapFor: StorageCapResolver;
  signatureCheck: SignatureCheck;
  screeningFor: (accountId: string) => Promise<Pick<SyncDeps, "ohboxPolicy" | "ohboxBar" | "screeningCutoff" | "signatures">>;
  organizerInstallId: string;
  organizerDisplayName: string;
  organizerStaleAfterMs: number | undefined;

  /* ── start/lease-gate.ts ── */
  clockCorrections: () => number;
  refreshReaderHolder: (
    mb: { mailboxId: string; accountId: string },
    adapter: MailboxAdapter,
    current: {
      kind: string | null; name: string | null; since: Date | null; state: string | null;
      capabilities: string | null; installId: string | null;
      gapOpen?: boolean;
      lastLookAt?: number;
    },
  ) => Promise<void>;
  leaveSettings: (rt: MailboxRuntime) => Promise<void>;
  agreeSweepVisit: (rt: MailboxRuntime) => Promise<void>;
  mayOrganize: (
    mb: { mailboxId: string; accountId: string },
    lease: {
      takeoverAuthorizedAt: Date | null; disabledReason: string | null;
      takeoverIntent: OrganizerIntent;
      organizerRole: OrganizerRole;
      organizeConsentedAt: Date | null;
      releaseRequestedAt: Date | null;
      organizerReleasedAt: Date | null;
    },
    holder: { readonly installId: string | null; readonly state: string | null },
    nonce: {
      leaseNonce: string | null; leaseMintedNonces: readonly string[]; seenClockCorrections: number;
      leasePermit: OrganizerWriteAuthority;
      agreeStamp?: Date | null;
      claimServerAt?: Date | null;
    },
    adapter: MailboxAdapter,
    phase: "attach" | "cycle",
    requestKeyForGate: string | null,
    leaving?: () => Promise<void>,
  ) => Promise<boolean>;
  releaseOrganizerClaim: (
    rt: {
      mailboxId: string; accountId: string; adapter: MailboxAdapter;
      leaseNonce: string | null;
      leaseMintedNonces?: readonly string[];
    },
    why: string,
  ) => Promise<number | null>;

  /* ── start/quarantine.ts ── */
  quarantineMailbox: (mailboxId: string, accountId: string, reason: unknown, phase: MailboxErrorPhase, kickAsRead?: string | null) => Promise<void>;
  markRecovered: (mb: { mailboxId: string; accountId: string }, authKickAsRead?: string | null) => Promise<void>;
  recoverableReadBreaches: WeakSet<object>;
  closedOwed: Map<string, MailboxRuntime>;
  CLOSED_DETACH_REASON: string;
  handleConnectionError: (mailboxId: string, accountId: string, err: unknown, raisedOn?: MailboxAdapter | null) => void;

  /* ── start/attach.ts ── */
  detach: (rt: MailboxRuntime, reason: string) => Promise<void>;
  attach: (mb: EnabledMailbox, ticket: AttachTicket) => Promise<void>;

  /* ── start/roster.ts ── */
  reconcileRoster: (onInitialAttaches?: (work: Promise<{ fault: unknown | null }>) => void) => Promise<void>;
  requestRoster: () => void;
  yieldToRoster: () => Promise<void>;

  /* ── start/cycle.ts ── */
  cycle: (poll: boolean, visits: ReadonlySet<string>) => Promise<void>;

  /* ── start/cycle-tail.ts ── */
  tailWalk: TailWalk | null;   // changes
  tailQueued: boolean;   // changes
  owedReadAt: Date;   // changes
  kickTail: () => void;
  tailPosition: () => { section: string; account: number; of: number } | null;
  backfillQueued: boolean;   // changes
  backfillCursor: number;   // changes
  kickThreadBackfill: () => void;

  /* ── start/heartbeat.ts ── */
  beat: (opts?: { required?: boolean }) => Promise<void>;
  unservedBreakdown: () => UnservedBreakdown;
  degradedCauses: () => DegradedCauses;
  counters: () => {
    mailboxes: number; expected: number; accounts: number; quarantined: number;
    degraded: boolean; lastCycleAt: Date | null; aiCircuitOpenSince: Date | null;
    aiProviderOkAt: Date | null;
  };
  pulse: () => Promise<void>;
  alertPass: () => Promise<void>;

  /* ── The start file's end: the lock guard, the timers, the teardown ── */
  cycleQueued: boolean;   // changes
  kickCycle: (options?: { poll?: boolean; visit?: Iterable<string> }) => void;
  verifyErrors: number;   // changes
  hbTimer: ReturnType<typeof setInterval> | null;   // changes
  pollTimer: ReturnType<typeof setInterval> | null;   // changes
  rosterTimer: ReturnType<typeof setInterval> | null;   // changes
  alertTimer: ReturnType<typeof setInterval> | null;   // changes
  syncKickBell: SyncKickBell | null;   // changes
  pushWake: RunningPushWake | null;   // changes
  wakeHub: ChangeWakeFanout | null;   // changes
  apiCron: ApiCronHandle | null;   // changes
  signalPoll: PlatformSignalPollHandle | null;   // changes
  /** The calendar's passes (`start/calendar.ts`), or `null` where this deployment keeps no calendar. */
  calendar: CalendarRunner | null;   // changes
  handleLockLoss: (err: LockLostError) => void;
  unproven: number;   // changes
  verifying: boolean;   // changes
  pulsing: boolean;   // changes
  teardown: Promise<void> | null;   // changes
}
