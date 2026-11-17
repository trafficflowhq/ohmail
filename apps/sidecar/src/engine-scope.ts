import type { KeyProvider, KekEnvIdentity, OpenSendAdapter } from "@trafficflow/core/mail";
import type { ImapConfig, NetTimeouts } from "@trafficflow/core/adapters/imap";
import type { DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { SignatureCheck } from "@trafficflow/core/adapters/dkim";
import type { AuthConfig, UnsubscribeService, SearchSupersede } from "@trafficflow/services/mail";
import type { App, ProbeDialer, SmtpProbeOptions, ApiDeps } from "@trafficflow/api/local";
import type { SignOutFence } from "./signout-fence.js";
import type { ResolvedHostConfig } from "./host-listener.js";
import type { SyncDeps } from "@ohmail/organizer/sync";
import type { OrganizerKind } from "@trafficflow/core/adapters/organizer-lease";
import type { ScreenerAutoActSettings } from "@ohmail/organizer/screener-auto-act";
import type { ThreadJoinHealCursor } from "@ohmail/organizer/thread-join-heal";
import type { ImpersonationCutlineSettings } from "@ohmail/organizer/screener-impersonation";
import type { LocalAi } from "./ai-provider.js";
import type { OpenLocalDb, LocalDb } from "./db.js";
import type { LocalWorld, LocalRosterRow } from "./identity.js";
import type { mintLaunchBearer } from "./launch-bearer.js";
import type { LocalRoster, LocalMailboxRuntime, DialAnswer } from "./roster.js";
import type { createWindowOutbox } from "./window-outbox.js";
import type { createAttentionClock } from "./attention.js";
import type { SearchBackfill } from "./search-backfill.js";
import type { SearchWarmup } from "./search-warmup.js";
import type { createStatisticsUpkeep } from "./store-statistics.js";
import type { CadenceClocks, CadenceStamp } from "./pass-cadence.js";
import type { FirstSyncReporter } from "./first-sync.js";
import type { LoopDelaySample } from "./loop-delay.js";
import type { ReconnectProfile } from "./engine-reconnect.js";
import type { Diagnostic } from "./log.js";

/**
 * WHAT THE ENGINE'S SECTIONS SHARE, per install. One object, made once by `createSidecar` and handed to every
 * section's maker. A field marked "changes" is a variable the sections write; every other field is set once,
 * where its declaration stands (the door's own names) or at its section's end, and never again.
 */
export interface EngineScope {
  /* ── engine.ts (the head) ── */
  log: Diagnostic;
  now: () => Date;
  monotonic: () => number;
  cadenceClocks: CadenceClocks;
  address: string;
  drainTurns: { fold(sample: LoopDelaySample): void; take(): LoopDelaySample | null; };
  signatureCheck: SignatureCheck | null;
  organizerKind: OrganizerKind;
  reconnect: ReconnectProfile;
  walkTurn: (() => Promise<void>) | undefined;
  agreePages: number | undefined;
  agreeSlices: number | undefined;
  engineBuild: string | null;
  pollIntervalMs: number;
  idlePollCeilingMs: number;
  detachWaitMs: number;
  heartbeatTimeoutMs: number;
  connectionsAnsweredLine: string;   // changes
  connectionsAnsweredAt: number;   // changes
  tBoot: number;
  opened: OpenLocalDb;
  db: LocalDb;
  statisticsUpkeep: ReturnType<typeof createStatisticsUpkeep>;
  knownSetStatisticsOnce: () => Promise<void>;
  yieldToFirstPage: () => Promise<void>;
  world: LocalWorld;
  session: Awaited<ReturnType<typeof mintLaunchBearer>>;
  worldMs: number;
  inheritedSends: readonly string[];
  authConfig: AuthConfig;
  durableKey: boolean;
  keyProvider: KeyProvider;
  kekIdentity: KekEnvIdentity | null;
  ai: LocalAi;
  hostConfig: ResolvedHostConfig;
  hostMode: boolean;
  app: App;

  /* ── engine-request-deps.ts ── */
  unsubscribe: UnsubscribeService;
  probeOpts: {
      adapterFactory?: ((cfg: ImapConfig) => ProbeDialer) | undefined;
      loopbackCertificate: (dial: {
          host: string;
          port: number;
          secure: boolean;
          protocol: "imap" | "smtp";
      }, opts?: {
          timeoutMs?: number;
          now?: () => Date;
      }) => Promise<{
          sha256: string;
          pem: string;
      } | null>;
      localServerDial: NetTimeouts;
  } | {
      adapterFactory?: ((cfg: ImapConfig) => ProbeDialer) | undefined;
      loopbackCertificate?: undefined;
      localServerDial: NetTimeouts;
  };
  smtpProbeOpts: SmtpProbeOptions;
  openLocalSend: OpenSendAdapter;
  depsFor: () => ApiDeps;
  hostAuthConfig: AuthConfig;

  /* ── engine.ts (the shared state) ── */
  stopping: boolean;   // changes
  holdOffer: () => boolean;
  organizedHereIds: Set<string>;
  gapCatchupReady: Set<string>;
  gapOwed: Set<string>;
  arrivalsSaid: Set<string>;
  onceForTheAccount: (fn: () => Promise<void>) => Promise<void>;
  repo: DrizzleRepo;
  cycleRepo: DrizzleRepo;
  installId: string;
  clockCorrections: () => number;
  machineName: string;
  runtimes: LocalRoster;
  fence: SignOutFence;
  discardCredentialsFor: (mailboxId: string) => Promise<void>;
  signedOutAtOf: (mailboxId: string) => Promise<Date | null>;
  runtimeRosterRow: (rows: readonly LocalRosterRow[], id: string) => LocalRosterRow | null;

  /* ── engine-account-passes.ts ── */
  screeningNow: () => Promise<Pick<SyncDeps, "ohboxPolicy" | "ohboxBar" | "screeningCutoff" | "signatures"> & {
      actSettings?: ScreenerAutoActSettings;
      impersonation?: {
          on: boolean;
      } & ImpersonationCutlineSettings;
  }>;
  resurfaceDue: () => Promise<void>;
  retroDue: () => Promise<void>;
  gapCatchupDue: () => Promise<void>;
  suggestNew: (ohboxBar?: string) => Promise<void>;
  actOnSuggestions: (settings?: ScreenerAutoActSettings) => Promise<void>;
  passDue: (at: CadenceStamp | null, everyMs: number) => boolean;
  lastJoinHealAt: CadenceStamp | null;   // changes
  lastCorrespondentRetroAt: CadenceStamp | null;   // changes
  lastInboundQuietAt: CadenceStamp | null;   // changes
  joinHealCursor: ThreadJoinHealCursor | undefined;   // changes
  backfillSenderChecks: () => Promise<void>;
  impersonationOwed: boolean;   // changes
  impersonationLastOn: boolean | null;   // changes
  impersonationSettledOver: string | null;   // changes
  settledMailboxIds: () => string[];
  fileImpersonations: (settings: { on: boolean } & ImpersonationCutlineSettings, mailboxIds: string[]) => Promise<void>;
  backfillListAddresses: () => Promise<void>;
  tidyGoneLetters: () => Promise<void>;
  backfillStoredNames: () => Promise<void>;
  repairInferredPresses: () => Promise<void>;
  retireActAdmissions: () => Promise<void>;

  /* ── engine-press.ts ── */
  depsForHost: () => ApiDeps;
  consentableRefusal: (err: unknown) => boolean;
  trustableRefusal: (err: unknown) => boolean;
  pairSharesHost: (mailboxId: string) => Promise<boolean>;
  keepingIncoming: <T>(body: Record<string, unknown>, run: (b: Record<string, unknown>) => Promise<T>) => Promise<T>;
  answerPressLaunch: (mailboxId: string, rt: LocalMailboxRuntime, answer: Promise<DialAnswer | null>) => Promise<void>;

  /* ── engine.ts (the seed and the warm-up) ── */
  isSeedRow: (address: string) => boolean;
  searchWarmup: SearchWarmup | null;   // changes

  /* ── engine.ts (the mailbox's assembly) ── */
  attachLocal: (mb: LocalRosterRow, isSeed: boolean) => Promise<LocalMailboxRuntime>;

  /* ── engine-window-services.ts ── */
  stopVitals: () => void;
  firstSyncLog: FirstSyncReporter;
  attention: ReturnType<typeof createAttentionClock>;
  launchBearerAuthorized: (r: Request) => Promise<boolean>;
  windowOutbox: ReturnType<typeof createWindowOutbox> | null;
  searchBackfill: SearchBackfill | null;
  htmlWordsBackfill: SearchBackfill | null;
  searchIndexDoor: (req: Request) => Promise<Response>;
  laned: (door: (req: Request, supersede: SearchSupersede | undefined) => Promise<Response>) => (req: Request) => Promise<Response>;
  asPerson: (req: Request, run: () => Promise<Response>) => Promise<Response>;
  noteDoorWrite: (req: Request, res: Response) => void;

  /* ── engine-request-door.ts ── */
  handle: (req: Request) => Promise<Response>;
}
