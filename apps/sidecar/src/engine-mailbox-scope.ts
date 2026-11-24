import type { MailboxDisabledReason } from "@trafficflow/db";
import type { BlankRepairMode, UNMETERED_STORAGE_CAP, Logger } from "@trafficflow/core/mail";
import type { ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { DrizzleRepo, AgreeSweepCursor } from "@trafficflow/core/adapters/drizzle-repo";
import type { KnownSetCache } from "@ohmail/organizer/known-set";
import type { DeadLetterLedger } from "@ohmail/organizer/dead-letter";
import type { OrganizerWriteAuthority } from "@ohmail/organizer/lease";
import type { OrganizerIntent, LeasePeekAnswer } from "@trafficflow/core/adapters/organizer-lease";
import type { OrganizerProfileSync } from "@ohmail/organizer/profile";
import type { ArrivalBackfill } from "./arrival-backfill.js";
import type {
  CredentialState, CredentialBlock, CandidateDial, CandidateClaim, OrganizerState, LocalMailboxRuntime,
} from "./roster.js";
import type { CadenceStamp } from "./pass-cadence.js";
import type { FirstSyncTracker } from "./first-sync.js";
import type { SidecarImapConfig } from "./engine-types.js";
import type { WallWait } from "./engine-reconnect.js";

export type ReconnectProof = {
  deadSince: Date | null;
  detectedBy: "event" | "bound" | "heartbeat" | "credential" | "replaced" | null;
  served: boolean;
};

/**
 * WHAT ONE MAILBOX'S SECTIONS SHARE, per attached mailbox. One object, made once per `attachLocal` and handed to
 * that mailbox's makers; no other mailbox sees it. A field marked "changes" is a variable the sections write;
 * every other field is set once, at its section's end, and never again.
 */
export interface MailboxScope {
  /* ── engine-mailbox-login.ts ── */
  mbImap: SidecarImapConfig;   // changes
  storedLogin: () => Promise<{ secretEnc: string; keyVersion: number; meta: unknown } | null>;
  purgeCredential: (opts?: { keepCoordinates?: boolean }) => Promise<boolean>;
  forgetStoredLogin: (opts?: { keepCoordinates?: boolean }) => Promise<boolean>;
  resolveLogin: (opts?: { smtpHost?: string }) => Promise<{
      state: CredentialState;
      pass: string | null;
      foreign?: "incoming" | "outgoing" | "outgoing-none";
  }>;
  signedOutSinceDial: () => boolean;
  login: { state: CredentialState; pass: string | null; foreign?: "incoming" | "outgoing" | "outgoing-none"; };   // changes
  imapConfig: ImapConfig;
  requestKey: string | null;   // changes
  useDialledPassword: (pass: string) => void;
  connectionDeadSince: Date | null;   // changes
  outageSince: Date | null;   // changes
  connectionDeadBy: "event" | "bound" | "heartbeat" | "credential" | "replaced" | null;   // changes
  heartbeatUnaskable: boolean;   // changes
  signInRefused: boolean;   // changes
  wentQuiet: boolean;   // changes
  certificateRefusedNow: boolean;   // changes
  plaintextRefusedNow: boolean;   // changes
  credentialBlock: CredentialBlock | null;   // changes
  needsCredential: boolean;   // changes
  needsCredentialSince: Date | null;   // changes
  launchSkipped: boolean;   // changes
  importStamped: boolean;

  /* ── engine-mailbox-connection.ts ── */
  firstSync: FirstSyncTracker;
  clearSignInRefusal: (why: string, next?: string) => void;
  redialAttempts: number;   // changes
  reconnectProof: ReconnectProof | null;   // changes
  redialWait: WallWait;
  forcedWait: WallWait;
  networkWait: WallWait;
  generation: number;   // changes
  loginGeneration: number;   // changes
  deadGeneration: number;   // changes
  deadByBreach: boolean;   // changes
  assertSameConnection: (gen: number, conn: MailboxAdapter) => void;
  jittered: (stepMs: number) => number;
  climbTheLadder: () => void;
  noteLoginUnusable: (state: CredentialBlock["state"]) => void;
  moving: boolean;   // changes
  adoptRowDial: () => Promise<boolean>;
  claimOnCandidate: (dial: CandidateDial) => Promise<CandidateClaim>;
  rereadCredential: () => Promise<boolean>;
  adoptSeedConsent: () => Promise<void>;
  pinPlaintextDial: (cfg: ImapConfig) => Promise<void>;
  dialAdapter: () => MailboxAdapter;
  noteConnectionDead: (err: unknown, gen: number, who: MailboxAdapter | null) => void;
  leaseUnavailableSince: CadenceStamp | null;   // changes
  leaseUnavailableCycles: number;   // changes
  noteCycleServed: () => void;
  noteStoreFaultDrain: () => void;
  noteCycleFailed: (err: unknown) => void;
  noteFetchRefused: (err: unknown) => void;
  heartbeat: () => Promise<void>;
  armHeartbeat: () => void;
  adapter: MailboxAdapter;   // changes
  closeDialAfterSignOut: () => Promise<void>;
  deadLetters: DeadLetterLedger;
  syncDeps: {
      blankRepair?: BlankRepairMode | undefined;
      buildVersion?: string | undefined;
      trustedAuthservIds: ReadonlySet<string>;
      storageCap: typeof UNMETERED_STORAGE_CAP;
      deadLetters: DeadLetterLedger;
      log?: Logger | undefined;
      repo: DrizzleRepo;
      adapter: MailboxAdapter;
      accountId: string;
      mailboxId: string;
  };

  /* ── engine-mailbox-state.ts ── */
  stopped: boolean;   // changes
  timer: ReturnType<typeof setTimeout> | null;   // changes
  idlePollMs: number;   // changes
  restMayBeTaken: boolean;   // changes
  unwatch: (() => Promise<void>) | null;   // changes
  wakePending: boolean;   // changes
  ringQueued: boolean;   // changes
  seenPushQueued: boolean;   // changes
  timerDueAt: number;   // changes
  floorPoll: WallWait;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;   // changes
  heartbeatInFlight: Promise<void> | null;   // changes
  heartbeatSettledAtMs: number | null;   // changes
  tail: Promise<unknown>;   // changes
  queued: number;   // changes
  serialize: <T>(fn: () => Promise<T>) => Promise<T>;
  stopStartedAt: number | null;   // changes
  heldForRemoval: boolean;   // changes
  stopLeft: () => number;
  leaseNonce: string | null;   // changes
  leaseMinted: readonly string[];   // changes
  noteMinted: (n: string) => void;
  seenClockCorrections: number;   // changes
  leasePermit: OrganizerWriteAuthority;   // changes
  lastLeaseRenewalAt: Date | null;   // changes
  claimServerAt: Date | null;   // changes
  arrivals: ArrivalBackfill | null;
  drainDeclined: boolean;   // changes
  handedBack: boolean;   // changes
  priorStandDown: string | null;   // changes
  organizer: OrganizerState;   // changes
  takeoverAuthorized: boolean;   // changes
  observedTakeoverAt: Date | null;   // changes
  observedIntent: OrganizerIntent;   // changes
  consented: boolean;   // changes
  foldersEnsured: boolean;   // changes
  agreeSweep: { stamp: Date; cursor: AgreeSweepCursor | null } | null;   // changes
  standDownAppointments: (reason: MailboxDisabledReason, sentence?: string) => Promise<void>;

  /* ── engine-mailbox-claim.ts ── */
  profileSync: OrganizerProfileSync;
  holderLooked: boolean;   // changes
  gapOpen: boolean | null;   // changes
  lastPassOrganizing: boolean;   // changes
  gateContinued: boolean;   // changes
  peekOrganizer: () => Promise<LeasePeekAnswer>;
  lettingGo: () => Promise<{ gap: { since: string; by: string; at: string } }>;
  settingsNotLeft: (left: Awaited<ReturnType<MailboxScope["profileSync"]["flushBeforeLeaving"]>>, phase: "quit" | "background") => void;
  mayOrganize: () => Promise<boolean>;

  /* ── engine-mailbox-sends.ts ── */
  sendScheduled: (gen: number, conn: MailboxAdapter) => Promise<void>;
  answerAway: (gen: number, conn: MailboxAdapter, permit: OrganizerWriteAuthority) => Promise<void>;
  reconcileStrandedSends: () => Promise<void>;
  fileOwedSentCopies: () => Promise<void>;

  /* ── engine-mailbox-drain.ts ── */
  knownSet: KnownSetCache;
  knownSetMark: string | null;   // changes
  settledDrain: (maxCycles: number, gen: number, conn: MailboxAdapter, organizing: boolean) => Promise<number>;
  shrinkRefusedMeta: (err: unknown, conn: MailboxAdapter) => Promise<boolean>;
  markLeaseRefused: (err: unknown) => void;

  /* ── engine-mailbox-loop.ts ── */
  changeLogMark: () => Promise<string | null>;
  syncUntilQuiet: (maxCycles?: number, opts?: { force?: boolean }) => Promise<number>;
  schedule: (delayMs?: number) => void;
  onMailboxSignal: () => void;
  noteWorldMoved: () => void;
  pushSeen: () => void;
  armWake: (conn: MailboxAdapter) => Promise<void>;

  /* ── engine-mailbox-dial.ts ── */
  onDialled: (() => void) | null;   // changes
  dialAndGate: () => Promise<{ leaseRead: boolean; drainError?: unknown }>;
  redialling: boolean;   // changes
  redialInFlight: Promise<void>;   // changes
  redialIfDead: (opts?: { force?: boolean }) => Promise<void>;

  /* ── engine-mailbox-runtime.ts ── */
  rt: LocalMailboxRuntime;
}
