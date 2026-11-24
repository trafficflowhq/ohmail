// The desktop's engine: the engine's public types: its settings, what it hands back, the start's phases and the quit's plan and report.

import type { BlankRepairMode, Logger } from "@trafficflow/core/mail";
import type { ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { DkimKeyLookup } from "@trafficflow/core/adapters/dkim";
import type { OneClickPost, RemoteFetch, MailboxProbeVerdict } from "@trafficflow/services/mail";
import type { SmtpProbeOptions, App } from "@trafficflow/api/local";
import type { HostState } from "./host-listener.js";
import type { LanState } from "./host-lan.js";
import type { LanIdentity } from "./host-lan-tls.js";
import type { LeasePeekAnswer, OrganizerKind } from "@trafficflow/core/adapters/organizer-lease";
import type { LocalDb, LocalDbOpenPhase, MigrationProgress, OpenLocalDb } from "./db.js";
import type { LocalWorld } from "./identity.js";
import type { CredentialState, DialAnswer, MailboxConnectionState, OrganizerState } from "./roster.js";
import type { PowerVerdict } from "./host-power.js";
import type { Diagnostic } from "./log.js";
import type { LoopDelayReader } from "./loop-delay.js";

/**
 * The shape {@link SidecarConfig.store} supplies — `openLocalDb`'s own signature, named so a
 * caller can be typed against it without importing the desktop's implementation.
 */
export type OpenLocalDbFn = (
  dataDir: string,
  opts: {
    log?: Diagnostic;
    onPhase?: (phase: LocalDbOpenPhase, progress?: MigrationProgress) => void;
    onFatal?: (fatal: Error) => void;
  },
) => Promise<OpenLocalDb>;

/**
 * The user's own server, with the PASSWORD OPTIONAL — which is the whole shape of this type.
 *
 * Host, port and username are settings: the shell has them and passes them on every launch. The
 * password is a secret, and after first run it lives envelope-encrypted in `mailbox_credentials`
 * rather than in this process's environment. A launch that carries no password is therefore the
 * STEADY STATE and not an error, so the type has to be able to say so.
 */
export type SidecarImapConfig = Omit<ImapConfig, "auth"> & { auth: { user: string; pass?: string } };

/**
 * The two facts that are per MAILBOX rather than per install — whether this machine can open
 * one, and whether it organizes it — live with the runtime that holds them (`roster.ts`), and
 * are re-exported here so every caller that already reads them off this module is unchanged.
 *
 * They moved because an install now answers them N times. A single `CredentialState` for the
 * process was the same statement as the mailbox's while there was one mailbox; with several it
 * would be an answer about whichever one the shell happened to ask about last.
 */
export type {
  CredentialBlock, CredentialState, DialAnswer, FirstSyncState, MailboxConnectionState, OrganizerState,
} from "./roster.js";

/**
 * WHAT THE ENGINE HANDS A DIAL — currently the one thing an adapter cannot report by throwing.
 *
 * A record rather than a bare callback parameter so the next connection-scoped fact (a logger
 * bound to the mailbox id, a clock) is added without re-writing every double's signature. The
 * hosted worker passes the same shape to its own factory.
 */
export interface AdapterDialContext {
  /**
   * The connection died between calls. Called from an event handler, so it MUST NOT THROW and
   * must not await anything the caller depends on — see `ImapAdapter#guardAsyncErrors`, which
   * swallows whatever comes back out of it.
   */
  onConnectionError: (err: unknown) => void;
}

export interface SidecarConfig {
  /** Where the local mirror lives. Created if absent; locked while open. */
  dataDir: string;
  /** The shell's staging folder for a save (`OHMAIL_ATTACHMENT_STAGING_DIR`); absent, no save route. */
  attachmentStagingDir?: string;
  /**
   * WHERE THE OPERATOR'S CERTIFICATE AUTHORITY IS — the shell's one path, as the cloud engine gets
   * it: this engine answers the link and server check too (`cloud-probe.ts`), and a check that read
   * another folder than the door it leads to would admit a server that door then cannot verify.
   */
  operatorCaFile?: string;
  /** The user's own IMAP (and optionally SMTP) server. */
  imap: SidecarImapConfig;
  /** The mailbox address. Defaults to the IMAP username, which is what it is for most servers. */
  address?: string;
  /**
   * The shell's first local door, not saved yet (`OHMAIL_DOOR_PENDING`): this start records the
   * attempt, and the next start keeps it only as the save of the same address (`first-door.ts`).
   */
  doorPending?: boolean;
  /** The shell's save of its own pending first local door (`OHMAIL_DOOR_SAVE`): the start that keeps it. */
  doorSave?: boolean;
  displayName?: string;
  /** How long to wait between cycles when the mailbox is quiet. */
  pollIntervalMs?: number;
  /**
   * The ceiling the idle ladder climbs to — a TEST SEAM. Production takes
   * {@link IDLE_POLL_CEILING_MS}; a cell that wants to watch the ladder reach its top inside a
   * second sets a small one. Below {@link pollIntervalMs} it simply means "never rest".
   */
  idlePollCeilingMs?: number;
  /** TEST SEAM: the search backfill's clocks (`search-backfill.ts`); production takes its constants. */
  searchBackfillTiming?: { waitMs?: number; tickMs?: number; quietMs?: number };
  /**
   * IS THIS MACHINE ON POWER — asked by the store-only pass before each round. The desktop entry
   * (`main.ts`) supplies `createHostPower`; absent ⇒ no reading, which the pass runs on as a host
   * that cannot say. Injected, never imported here: the phone bundles this module, and a value
   * import would put a filesystem reader it never runs into its artifact.
   */
  hostPower?: () => PowerVerdict;
  /**
   * A loop-delay monitor, one per drain (`sync_drain`, folded into `engine_vitals`). The desktop
   * entry supplies `nodeLoopDelay`; injected for `hostPower`'s reason (the phone's `perf_hooks` refuses).
   */
  loopDelay?: () => LoopDelayReader;
  /**
   * How long a connection has to answer an IMAP NOOP before it is treated as dead. Absent means
   * {@link DEFAULT_HEARTBEAT_TIMEOUT_MS}; a value that is not a positive number refuses the boot.
   */
  heartbeatTimeoutMs?: number;
  /**
   * The blank repair's mode (`packages/organizer/src/blank-repair.ts`), handed to every cycle: `off` runs
   * nothing, `dry` reads and counts and writes nothing, `apply` repairs. Absent is apply. The desktop
   * reads `OHMAIL_BLANK_REPAIR` (`main.ts`), as the hosted worker does. The phone (`mobile.ts`) passes
   * `off`, always: its build carries no repair (the alias table substitutes a twin that refuses,
   * `phone/blank-repair.ts`), so it never runs one, whole or in part.
   */
  blankRepair?: BlankRepairMode;
  /**
   * Fill arrival times the store lost (`arrival-backfill.ts`), for rows taken in at or after
   * `floor`. Only the phone passes it: its engine stored every letter without one before it read
   * INTERNALDATE by hand. Absent, nothing is asked.
   */
  arrivalBackfill?: { floor: Date };
  /**
   * Diagnostics. NEVER stdout in the real process — stdout is the frame stream.
   *
   * Production passes `createSidecarLog()`, which is `packages/core`'s hardened logger. The same
   * function is handed to `readMailboxLease`, so anything the lease composition logs is redacted
   * by the same gate — which is why this stays a two-argument function and not a `Logger`.
   */
  log?: Diagnostic;
  /**
   * The same diagnostics, in the shape the shared sync loop speaks — this door once ran the loop with
   * `log` unset, so every `log?.warn`/`log?.error` in the reconcile passes chained into nothing: the
   * lines describing a write the mail server did NOT accept were discarded on the one door where the
   * local database is the only other witness. A second field rather than a wider `log` because {@link
   * Diagnostic} is a narrowing forced by `readMailboxLease`, and the level it derives is a claim about
   * this package's vocabulary (`log.ts`). Production builds one `createSidecarLogger()` and passes both
   * faces (`main.ts`; the log census asserts it). Absent ⇒ the loop's diagnostics are dropped — right
   * for tests, wrong for production, which is why the guard is on `main.ts` rather than this type.
   */
  logger?: Logger;
  /**
   * The per-install key ring, from the native shell's keystore: `version → 32-byte key`. The
   * shell owns the keystore; this Node child never reaches for one — exactly one thing crosses
   * the boundary, at spawn, in one direction. A ring and not one key, because a key that cannot
   * be rotated cannot be revoked: the hosted shape (`packages/core/src/crypto.ts`) — highest
   * version encrypts, older versions still decrypt, re-encryption is lazy — so rotation needs no
   * migration. Absent ⇒ this install has no durable key and nothing is sealed to disk at all:
   * credential storage is refused rather than performed badly ({@link refusingKeyProvider}), and
   * the shell passes the password on every launch as before.
   */
  keks?: Record<number, Buffer>;
  /**
   * HOW OFTEN THE ENGINE SAMPLES ITS OWN MEMORY. Default {@link ENGINE_VITALS_INTERVAL_MS}.
   *
   * A test seam AND a measurement knob: a guard that proved the timer by waiting for it would
   * take five minutes to fail, and a measurement run shorter than five minutes reads no figure
   * of the engine's own. `configFromEnv` fills it from `OHMAIL_ENGINE_VITALS_MS` within a
   * bounded range; an ordinary launch passes nothing and the shipped interval stands.
   */
  vitalsIntervalMs?: number;
  /**
   * Injected for tests; production dials a real server. The second argument is the
   * dead-connection callback, not optional furniture: `ImapAdapter` reports the one failure it
   * cannot throw — a socket dying between calls — via {@link ImapAdapterOpts.onConnectionError},
   * and the only place this engine can supply it is where the adapter is constructed. Passing it
   * through the factory gives a test double the same handle production gets (the worker's
   * `makeAdapter` shape, not a second convention). A double declaring one parameter keeps
   * working — absence of the second parameter means "this double never dies asynchronously".
   */
  adapterFactory?: (cfg: ImapConfig, ctx: AdapterDialContext) => MailboxAdapter;
  /**
   * THE SUBMISSION DIAL, for compositions that must be able to REFUSE one.
   *
   * `adapterFactory`'s presence already routes the smtp probe through a double that always
   * succeeds — the right default for a composition that must not open sockets. This is the seam
   * for the opposite case: proving that a refused submission server leaves the INCOMING credential
   * stored and the mailbox connected. Absent in production, where both legs dial for real.
   */
  smtpDial?: SmtpProbeOptions["dial"];
  /**
   * Test seam for the one-click unsubscribe POST — with `fetchImpl` below, one of exactly two
   * ways this process reaches a network that is not the mailbox; both exist so a test can count
   * what left the machine. Production gets `nodeOneClickPost`: the pinned, redirect-refusing,
   * body-discarding client the hosted API uses. The URL has already passed the same SSRF gate
   * (`assertPublicHttpUrl` over real DNS) — a desktop sits inside somebody's home network, and a
   * List-Unsubscribe header naming a LAN address is refused here for Cloud's reason; unlike the
   * probe, this URL is the sender's choice, never the user's own server.
   */
  oneClickPost?: OneClickPost;
  /**
   * THE DKIM KEY LOOKUP for the sender-signature check where a mailbox's provider names no
   * authserv-id (`pipeline.ts#signatureVerdict`) — a TXT query to the system resolver, and on to the
   * sender's DNS, for a letter from a company's own domain or a one-click letter. REQUIRED, and no
   * import here: the desktop's `main.ts` passes `makeDnsDkimKeys()`, the phone `null` (its DNS shim
   * refuses a TXT query), a test a counting fake. `null` checks nothing and the mailbox rows say so.
   */
  dkimKeys: DkimKeyLookup | null;
  /**
   * Test seam for the IMAGE PROXY's fetch — the third non-mailbox egress, beside
   * {@link oneClickPost} and the model endpoint, and here for the same reason they are: a test
   * can count what left the machine, and drive the gate's refusals without a network. Production
   * passes nothing and gets `nodeRemoteFetch`.
   */
  imageFetch?: RemoteFetch;
  /**
   * TEST SEAM for the ONE thing in this process that reaches a network other than the mailbox:
   * the model endpoint its owner configured. Production passes nothing and the platform's own
   * `fetch` is used.
   *
   * It is a seam rather than a module-level import so a test can prove the negative that matters
   * most — that an install with no model configured makes NO outbound request at all — by
   * counting calls rather than by reading the code and believing it.
   */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Letters one slice of the agree's sweep moves; absent is the core's bound. Tests set it smaller. */
  agreeSweepSlice?: number;
  /** Pages one slice of the agree's sweep reads; absent is the composition's (`COMPOSITION_WALKS`). */
  agreeSweepPages?: number;
  /** Slices one drain's sweep runs; absent is the composition's (`COMPOSITION_WALKS`). */
  agreeSweepSlices?: number;
  /**
   * The turn the organize walks hand the event loop after counted work. Absent is `loopTurn` where
   * the composition turns (`COMPOSITION_WALKS`) and none elsewhere. Tests pass a counting one.
   */
  loopTurn?: () => Promise<void>;
  /**
   * The monotonic clock the organizer permit reads beside `now` (`performance.now()`'s unit).
   * Absent means `performance.now()`; the permit refuses a runtime that has neither.
   */
  monotonic?: () => number;
  /**
   * How this install names itself in the organizer claim it writes to `ohmail/_meta`.
   *
   * The takeover prompt in Cloud's connect flow reads `ohmail on <machine> organizes this
   * mailbox`, so this has to be a name a human recognises.
   * Defaults to the machine's hostname, which is the only thing this process knows about the
   * machine without asking the shell.
   */
  machineName?: string;
  /**
   * How this install names its own kind in the organizer claim — `local` unless told otherwise.
   * The claim record in `ohmail/_meta` says what sort of install holds the mailbox, and every
   * other install ranks holders partly by it. A phone runs this same composition and is not a
   * desktop, so the literal became a field. Required-in-effect for every non-desktop
   * composition: an install that claims as `local` while being something else makes the holder
   * line lie on every other device — a false statement about who holds somebody's mailbox, not a
   * cosmetic slip.
   */
  organizerKind?: OrganizerKind;
  /**
   * Who this install is to the organizer lease — the local `accounts` row unless the shell knows better, and
   * on a phone it does. The lease's clone defence rests on this id: a claim bearing our id with a nonce we
   * did not write, still live, is a restored copy of us. On a desktop `world.accountId` is exactly that. A
   * phone breaks the equivalence: a restored device backup brings the app container back with the store in
   * it, so the restored copy carries the same `accountId` — two installs sharing an id are coalesced by the
   * lease into one, a second organizer nobody can see; hence the id comes from the install marker, rotated on
   * restore. Absent ⇒ `world.accountId`. It must be stable per install and differ between installs — one
   * generated per launch would read its own claim as a stranger's.
   */
  installId?: string;
  /**
   * Where the store comes from — the desktop's PGlite mirror unless the caller brings its own. A phone runs
   * this composition over SQLite through a one-statement queue, with no PGlite, lock file or filesystem
   * module; `openLocalDb` is all of those, so the phone's composition root opens its own store and hands it
   * over — the alternative being a second copy of this whole function, the fork the architecture ruling
   * exists to prevent. Optional with the desktop opener as default: `main.ts` and the test compositions say
   * nothing about a store and must go on saying nothing. The phone's bundle also substitutes `./db.js` itself
   * — two mechanisms, not redundant: the seam makes the composition correct, the substitution makes the
   * absence of PGlite a fact about the shipped file rather than a promise about branches.
   */
  store?: OpenLocalDbFn;
  /**
   * TEST SEAM. The lease's staleness window, which no test can afford to wait out.
   * Production takes the engine's ten minutes.
   */
  leaseStaleAfterMs?: number;
  /**
   * TEST SEAM. How often the portable organizer profile is re-serialized and compared against
   * what `ohmail/_meta` holds, at most (`@ohmail/organizer/profile`). Production takes the
   * composition's five minutes.
   */
  profileFlushIntervalMs?: number;
  /**
   * Told what the boot is about to spend its time on, phase by phase, as it happens.
   *
   * `boot_phases` (the log line at the bottom of this constructor) is the same story told
   * afterwards, with numbers; this is the live narration `main.ts` turns into `phase` frames so
   * the window can say "Replaying recent changes…" instead of one sentence for every wait.
   * Best-effort and never awaited: a boot must not be able to fail, or slow, because somebody is
   * watching it.
   */
  onPhase?: (phase: BootPhase, progress?: MigrationProgress) => void;
  /**
   * Told once, at the trap itself, when the local store's database ends under it (`db.ts`'s
   * `onFatal`): `main.ts` ends the process right there, the shell starts the engine again, and the
   * store recovers what was committed from its log.
   */
  onStoreFatal?: (fatal: Error) => void;
  /**
   * Host mode — this install serves its owner's other devices (Phase 3). Armed, three things
   * exist that otherwise do not: the stdio door gains the window-only pairing mint
   * (`hostPairRoutes`), `/hello` says `pairing: true`, and {@link Sidecar.handleHost} exists —
   * the desktop-host door's `Request → Response`, which the loopback listener binds and
   * `tailscale serve` publishes. Only the exact boolean `true` arms it: absent is byte-identical
   * to the pre-host build — no extra routes, no second door, `pairing: false`. An absent config
   * value must never select the dangerous branch; the disarmed composition is pinned by test in
   * both directions.
   */
  hostMode?: boolean;
  /**
   * The served origin — `https://<machine>.<tailnet>.ts.net`, what `tailscale serve` publishes and a
   * phone's browser therefore sends as `Origin` on every mutation. Threaded into the host door's
   * request-guard allow-list, and nowhere else — the stdio door's own auth config is untouched. Without
   * it, armed, the door still exists for the window and for tests driving `handleHost`, but the
   * listener refuses to start: a guard allow-listing only `http://localhost` would refuse every real
   * browser mutation as cross-site. Validated by the same `makeAuthConfig`/`assertOriginConfig` every
   * door boots through; a failing value turns host mode off for the launch with a surfaced reason
   * (`host_config_invalid`) and can never kill the stdio door.
   */
  hostOrigin?: string;
  /**
   * The loopback port the host door's listener binds — `127.0.0.1:<port>`, the target of the
   * shell's `tailscale serve` invocation. An integer in 1..65535; anything else (port 0
   * included — the serve target must not move between launches) turns host mode OFF for the
   * launch with the same surfaced reason as a bad origin. Absent ⇒ no listener.
   */
  hostPort?: number;
  /**
   * THE BUILT BROWSER CLIENT this door serves to a phone — a directory holding the host-client
   * vite arm's dist (`index.html` + hashed `assets/`), handed at spawn exactly as the data
   * directory is (`OHMAIL_HOST_ASSETS`). The shell resolves it from the packaged app's own
   * resources; nothing here trusts the value beyond probing it once (`host-static.ts`). Absent,
   * or naming no readable build, the armed door serves its API only and app routes answer one
   * plain sentence — a degradation with a logged reason (`host_assets_missing`), never a crash.
   */
  hostAssetsDir?: string;
  /**
   * THE LAN FALLBACK (`OHMAIL_LAN_BIND`) — one operator-chosen IPv4 interface address the host
   * door ALSO binds, plain HTTP, for same-network use without Tailscale. API-only by ruling:
   * the served browser client depends on secure-context APIs a plain-http network origin does
   * not provide, so this door serves `desktopHostRoutes` for native clients and an honest
   * explainer page for a browser — see `host-lan.ts`'s header for the audit. Meaningless
   * without `hostMode`; a refused value degrades the LAN half alone (`host_lan_config_invalid`)
   * and can never kill the stdio door or the Tailscale half. Absent ⇒ byte-identical to the
   * pre-LAN composition.
   */
  lanBind?: string;
  /**
   * WHICH BUILD THIS ENGINE IS — the commit the SHELL that spawned it was built from, handed
   * over at spawn (`OHMAIL_BUILD_COMMIT`) and published at `/health` as `buildCommit`. The
   * desktop download is one artifact with two halves, and until this existed only the window
   * could name a commit: the engine's reproducibility gate could compare two local builds and
   * never the shipped pair. Absent ⇒ nothing spawned this with a build identity (a dev run, an
   * older shell) and `/health` says nothing about it; the literal `unknown` ⇒ a shell that was
   * built without one — a different answer, and the gate refuses it by name.
   */
  buildCommit?: string;
}

/**
 * The boot, as the moments a person watching the window can be told about. The database phases
 * are {@link LocalDbOpenPhase}; `preparing` is everything after the store is open — identity,
 * key ring, the AI assembly, the route table — which is fast and is named so the narration never
 * just stops at the last database phase on a launch where the remainder is what is left.
 */
export type BootPhase = LocalDbOpenPhase | "preparing";

/**
 * A QUIT'S PLAN, in milliseconds from the moment the stop begins (`main.ts` derives them from the
 * shell's grace). The passes and the search backfill get `passMs`; the doors' requests keep the
 * store until they end or `requestsMs`; the store's wait for its admitted calls ends at
 * `storeWaitMs`, or a quarter second after the writers let go when that is later; the claim
 * releases, LOGOUTs and kept send connections end at `goodbyeMs`.
 */
export interface QuitPlan {
  passMs: number;
  /** Never earlier than `passMs`: a request is a writer at least as long as a pass is. */
  requestsMs: number;
  storeWaitMs: number;
  goodbyeMs: number;
  /** The doors' requests draining: a writer until `requestsMs`, then a goodbye until `goodbyeMs`. */
  requests?: Promise<unknown>;
}

/**
 * THE END OF A QUIT'S REQUEST WINDOW KEPT FOR A PRESS'S SUBMISSION AND ITS FINALIZE: a press whose
 * transport opens inside it is held for the next start (`SendDeps.holdOffer`), since the server's
 * accept could land after the store closed and lose its Sent copy. One second of the desktop's two:
 * a press offered earlier on a server answering in time is sent and recorded before the store closes.
 */
export const QUIT_OFFER_RESERVE_MS = 1_000;

/** What a planned stop spent, each in ms from its start except the store's two. */
export interface QuitReport {
  requestsMs: number;
  passesMs: number;
  storeWaitMs: number;
  storeCloseMs: number;
  goodbyesMs: number;
  /** Mailboxes whose socket had to be destroyed. */
  forced: number;
}

/** A planned stop whose store did not close: it stays recorded open and keeps its lock. */
export class QuitLeftOpenError extends Error {
  constructor(cause: unknown, readonly report: QuitReport) {
    super("the local store did not close inside the quit", { cause });
    this.name = "QuitLeftOpenError";
  }
}

export interface Sidecar {
  readonly app: App;
  readonly db: LocalDb;
  readonly repo: WorkerRepo;
  readonly adapter: MailboxAdapter;
  readonly world: LocalWorld;
  /** The per-launch bearer token. In memory only. */
  readonly sessionToken: string;
  /** `Request → Response`, with a fresh `ApiDeps` per call. This is what the stdio host serves. */
  handle(req: Request): Promise<Response>;
  /**
   * DID THIS INSTALL ORGANIZE THE MAILBOX — a gate in this process read its row saying `organizer`,
   * which only this install's own promotion writes. The claim watch's licence: it returns a mailbox
   * this install organized, and never one a refused press only recorded consent on.
   */
  organizedHere(mailboxId: string): boolean;
  /**
   * The foreground wake — re-dial every mailbox whose connection has died, now. One call for the
   * whole install, because the event is one event: the app came back to the foreground, or the
   * machine woke, and every socket this process held is stale at the same moment. Per-mailbox it
   * is {@link LocalMailboxRuntime.redial}, which restores a connection and never starts a drain.
   * Best-effort and never throws: one mailbox's dial failing must not stop the others, and a
   * wake is not a request anybody awaits. On the desktop nothing calls this — the poll's own
   * re-dial is the right cadence there; a phone's socket dies on every background, and the
   * alternative is "organizing" on screen while nothing is filed for two minutes.
   */
  wake(): Promise<void>;
  /**
   * Hand every mailbox back — the other half of {@link wake}, and only a phone has a caller. One
   * call for the whole install: the app is leaving the foreground on a platform that will not
   * let it keep running. Per mailbox it is {@link LocalMailboxRuntime.handBack}, which removes
   * the claim and writes no row. Answers one entry per mailbox rather than a single boolean:
   * "the claim was removed" and "the search was refused" are different facts, and a caller
   * rendering "handed back" must not do so for a mailbox whose claim may still stand (`null` is
   * that state). Nothing on the desktop calls this — a desktop not running is a machine switched
   * off and the lapse is right for it; a phone backgrounds many times an hour.
   */
  handBack(): Promise<readonly { mailboxId: string; released: number | null }[]>;
  /**
   * {@link handBack}'s LATCH ALONE, on every mailbox, now: each drain in flight stops at its next
   * cycle edge and no poll re-arms, and nothing is released. For a phone's Back queued behind a
   * {@link resume}; the caller follows with `handBack` or lifts it with `resume`.
   */
  leave(): void;
  /**
   * TAKE EVERY MAILBOX BACK IF NOBODY ELSE HAS IT — {@link handBack}'s other half, and only a
   * phone has a caller. Per mailbox it is {@link LocalMailboxRuntime.resume}: the hand-back is
   * cleared and one gated cycle runs, so a free mailbox is claimed and a held one is not.
   *
   * One entry per mailbox: `served` is the cycles its forced drain ran, and `0` is a cycle that
   * could not be served, which a caller must not render as the hand-back being over. A refusal
   * rejects, naming every mailbox that refused.
   */
  resume(): Promise<readonly { mailboxId: string; served: number }[]>;
  /**
   * WHO HOLDS ONE MAILBOX, ASKED NOW — the engine's own APPEND-less look, in three words.
   *
   * Exists so a door in this process can DECIDE from a look instead of from the holder columns.
   * The columns are refreshed once per cycle and carry two facts in one NULL — "nobody has ever
   * organized this" and "we have not looked" — and a door that reads that NULL as free admits a
   * press over a mailbox whose claim folder it could not see. Per mailbox, because the question
   * is per mailbox; a mailbox this install does not run answers `unreadable`, which is true.
   */
  peekOrganizer(mailboxId: string): Promise<LeasePeekAnswer>;
  /**
   * WHAT A STOP AND REMOVE WOULD LEAVE ONLY ON THIS INSTALL, for one mailbox: decisions waiting for the
   * settings question (`answer`), behind a newer ohmail's copy (`newer`), or `none`. The store's read,
   * never the mail server's; `null` for a mailbox this install does not run. `leaving`: read after the
   * hand-back, the store against the last copy written, with no shortcut (`OrganizerProfileSync`).
   */
  settingsLeftOnlyHere(mailboxId: string, opts?: { leaving?: boolean }): Promise<"answer" | "newer" | "none" | null>;
  /**
   * The desktop-host door — `Request → Response` over `desktopHostRoutes`, the surface a paired
   * phone reaches. Present IFF host mode is armed; a disarmed install has no second door at all,
   * not a refusing one. Same engine, store and fresh-deps discipline as {@link handle}, with
   * three composition differences that ARE the door: `/hello` answers `flavor: "desktop-host"`,
   * the window-only surfaces (`/local/*`, the pairing mint) are structurally absent, and the
   * request guard allow-lists the served origin (`SidecarConfig.hostOrigin`) — a phone's browser
   * sends the MagicDNS origin on every mutation. Bound by `host-listener.ts`, started by
   * `main.ts` from {@link hostState}.
   */
  handleHost?(req: Request): Promise<Response>;
  /**
   * What the host knobs resolved to — armed or not, the served origin and port the listener
   * needs, and the surfaced reason when host mode was asked for and refused. One reading
   * (`resolveHostConfig`), exposed so `main.ts` mounts the listener from the same answer the
   * composition was built from, and so the shell can render a degraded arm as a sentence.
   */
  readonly hostState: HostState;
  /**
   * THE LAN DOOR — {@link handleHost}'s API over the operator-chosen LAN interface, with the
   * one structural difference the API-only decision is: non-API paths answer a script-free explainer,
   * NEVER the packaged browser client (`serveLanFallback` — the secure-context audit is
   * `host-lan.ts`'s header). Present IFF host mode is armed AND `lanBind` resolved; the LAN
   * listener that binds this is `host-lan.ts`'s, started by `main.ts` from {@link lanState}.
   */
  handleLan?(req: Request): Promise<Response>;
  /**
   * What the LAN knob resolved to — the chosen address, or the surfaced reason it was refused.
   * One reading (`resolveLanBind`), exposed for the same two consumers `hostState` serves.
   */
  readonly lanState: LanState;
  /**
   * The LAN door's persistent TLS identity — the key a paired phone pins, resolved once here
   * because this composition knows the data directory. `null` when no LAN address was chosen, or
   * when the identity could not be established (`lanState.reason` says so and the door stays
   * SHUT rather than falling back to cleartext). Two consumers, deliberately one value:
   * `main.ts` serves TLS with it, and `GET /local/lan/pin` hands its fingerprint to the window
   * for the pairing link. A second reading would be a second chance for the link's fingerprint
   * and the door's key to disagree — a pairing that fails at the handshake with nothing to point
   * at.
   */
  readonly lanIdentity: LanIdentity | null;
  /**
   * Run cycles until the mailbox reports no backlog, then return how many ran.
   *
   * The drain is the contract, not an optimisation: `changesSince` returns a BOUNDED batch (the
   * adapter's memory budget, sized after an unbounded one exhausted the heap), holds the folder
   * cursor while truncated, and tells the caller so. A caller that ran one cycle per poll interval
   * would take a cold mailbox from minutes to hours, one batch per interval — the hosted sync
   * worker re-kicks for exactly this reason and so does this.
   */
  syncUntilQuiet(maxCycles?: number): Promise<number>;
  /**
   * Drain ONE mailbox, by row id. Answers how many cycles ran, and 0 for an id this install does
   * not run — which is an answer and not a fault: the row may have been removed between a caller
   * reading the list and asking about it.
   */
  syncMailbox(mailboxId: string, maxCycles?: number): Promise<number>;
  /**
   * Every mailbox's organizer state, keyed by row id.
   *
   * ADDITIVE beside {@link organizerState}, which keeps answering the seed's — the shell's
   * single-mailbox surfaces are not rewritten by this, and a caller that wants the whole picture
   * asks for it explicitly. A snapshot per call, never a live map: a poll writes these fields.
   */
  organizerStates(): Record<string, OrganizerState>;
  /**
   * Whether this install can reach each mailbox's server right now, keyed by row id.
   *
   * BESIDE {@link organizerStates} and never folded into it. The two answer different questions
   * and Settings needs both: this install is still the ORGANIZER of a mailbox it cannot currently
   * REACH, and collapsing the pair would either invite somebody to take back a mailbox nobody
   * took, or let the pane go on saying "On this machine" over a socket that has been dead for an
   * hour. A snapshot per call, like its neighbour.
   */
  connectionStates(): Record<string, MailboxConnectionState>;
  /**
   * Connect, ensure the `ohmail/*` tree exists, drain, then poll — and say which mailboxes could
   * not be launched. It still does not throw for a mailbox (one dead server must not take the
   * others down), and callers that ignore the answer keep their behaviour. The answer exists
   * because a launch failure was previously only a log line: the phone's fourth door — a
   * composition standing in front of a person who just typed a password — had no way to learn
   * the server had answered no, and reported the mailbox as opened. The report is data, not a
   * flag: each entry carries the original error, so a caller classifies it with the same
   * predicates this file uses ({@link credentialsRefused}).
   */
  start(): Promise<LaunchReport>;
  /**
   * {@link start}, with the seed's dial answered as well: every mailbox is started once, `report`
   * is what `start()` would have answered (the same loop and the same `mailbox_start_failed`
   * lines), and `seedDial` is the seed's login — opened, refused or not tried — or `null` with no
   * seed. The phone's Connect judges a typed password on that answer; `main.ts` keeps `start()`.
   */
  startAnswering(): { report: Promise<LaunchReport>; seedDial: Promise<DialAnswer | null> };
  /**
   * Whether this install is currently this mailbox's organizer, and if not, who is.
   *
   * A PROPERTY, never a toggle: the shell renders it as one line and at most one action. There
   * is deliberately no setter — ceasing to organize is automatic and becoming one is an explicit
   * human action that goes through the mailbox row, not through a field on this object.
   */
  organizerState(): OrganizerState;
  /**
   * Can this install open the user's mailbox right now? Read fresh from the store on every call
   * rather than cached from launch, because the answer changes while the process runs: the
   * shell's whole recovery flow is to show a password field, `PATCH /mailboxes/:id`, and ask
   * again — a cached value would still say `unreadable` after the user had fixed it. It never
   * returns the password, to this caller or any other; the plaintext exists in this process only
   * as the argument `ImapAdapter` was constructed with.
   */
  credentialState(): Promise<CredentialState>;
  /**
   * Forget the stored mailbox passwords; answers whether there was one to forget. The shell can
   * delete its own configuration and stop this process, but the sealed credentials live in the
   * mirror's database, which is frozen on a door switch rather than deleted — so they go here.
   *
   * IT DOES END THE LOGIN that password bought. The socket IS the credential in use: a poll timer
   * left running re-dialled from the copy the attachment still held. The sign-out epoch moves with
   * the row (`signout-fence.ts`), the live connection closes, and every later dial refuses.
   * `keepCoordinates: false` is a refused seal's discard — see the runtime's own method.
   */
  forgetStoredLogin(opts?: { keepCoordinates?: boolean }): Promise<boolean>;
  /**
   * DIAL ONE SUBMISSION SERVER NOW — its greeting and AUTH, through this composition's own SMTP
   * probe (the same seams, deadline and ladder the doors use). Nothing is stored. A phone's
   * Connect asks it, so an outgoing server that cannot deliver is refused at the press rather
   * than found at the first send.
   */
  probeSubmission(input: {
    address: string;
    smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
  }): Promise<MailboxProbeVerdict>;
  /**
   * Stop polling, let the in-flight cycle finish, GIVE EVERY CLAIM BACK, close IMAP, close and
   * unlock the database. The release is inside each mailbox's `detach()`, between the queue
   * settling and the logout: an install that is going down organizes nothing, and a claim left to
   * age out is `DEFAULT_STALE_AFTER_MS` in which NOBODY organizes the mailbox. The ROW is
   * untouched, so the next launch claims it back unless another install has taken it.
   *
   * With a {@link QuitPlan} (the desktop's quit, `main.ts`) the store closes FIRST: the passes get
   * `passMs` and the doors' requests until they end or `requestsMs`, then the store closes while the
   * claim releases, the LOGOUTs and any request still running go on beside it until `goodbyeMs`. A
   * store that could not close rejects with {@link QuitLeftOpenError}; a goodbye never rejects.
   * Without a plan the order is the one above, one drain interval per mailbox.
   */
  stop(): Promise<void>;
  stop(plan: QuitPlan): Promise<QuitReport>;
  /**
   * THE SHELL SAID WHY IT IS STOPPING THIS ENGINE — its `leaving` frame, before the EOF. Only
   * `"restart"` changes anything: the {@link stop} that follows keeps every claim for the relaunch,
   * which continues it under the same install id. Any other value is the ordinary quit.
   */
  leaving(reason: unknown): void;
}

/**
 * WHAT A LAUNCH COULD NOT OPEN — see {@link LocalSidecar.start}.
 *
 * Empty is the healthy answer AND the offline one: a mailbox with no usable password never
 * dials, which is not a failed launch (`start()` returns before `connect()` for it).
 */
export interface LaunchReport {
  readonly failures: readonly { readonly mailboxId: string; readonly err: unknown }[];
}
