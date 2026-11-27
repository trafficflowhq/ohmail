/**
 * The connection layer — one live session for the whole app, as a React context.
 * `useConnection()` answers the state (idle, connecting/live, refused, ended); the live state
 * carries the engine + store; only the connection screens drive transitions. Teardown awaits
 * the in-flight drain (a closed mirror reopens under a live drain's next flush); a refused
 * boot is a refusal, not a degraded mode; a failed sync re-hydrates. Every transition runs
 * through the {@link TransitionGate}, serialized last-wins; the bearer manager is the slot's,
 * one per profile for the process (`bearer-registry.ts`). Profiles cross as ids, re-read from
 * the keystore inside the gate; the dead signal lands on `ended`.
 */
import { calendarProfileMayRecover } from "../calendar/live-port";
import { calendarLifecycle } from "../calendar/calendar-native";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, AppState, Platform } from "react-native";
import { classifyWindowSyncFailure, unsentDraftsOf, type PullRing } from "@ohmail/client-engine";
import { Copy } from "../copy";
import { PAIRING_DEVICE_NAMES } from "../copy.en";
import { faultDetail, refuse, type Refusal, type RefusalArg } from "../refusal";
import { LOCAL_ENGINE_ORIGIN, mirrorExists, mirrorOwnerKey } from "../engine/boot";
import { nativeEngineDeps } from "../engine/native";
import {
  discardStandaloneLaunch, endStandaloneForRemoval, endStandaloneHere, holdStandaloneDoor, organizerDoor, sayOrganizeRefused,
  sayReadingAtConnect,
  pressConsentHere, takeConsentPress, sayOrganizerRestricted, standaloneHere, standaloneLaunchGeneration,
  type SettingsKeptHere,
} from "../engine/organizer-session";
import { engineLogSink, logNetwork } from "../engine/engine-log";
import { accessLock, clearAccessLock, onAccessLock } from "./access-lock";
import { clearUpdateAnswer } from "./update-answer";
import { decidedState, type DecidedState } from "./decided";
import { deathRefusal } from "./session-death";
import {
  CLAIM_LAPSES_AFTER_MINUTES, PHONE_CLAIM_NAME, organizesHere, reopenStandaloneMailbox,
  type ReopenOutcome, type StandaloneEngine, type StoreMigrating,
} from "../engine/standalone-door";
import { migratingState, type BootMigrating } from "../ui/boot-migrating";
import { phoneEngineReopen } from "../engine/engine-artifact";
import { installGeneration, settleInstallGeneration } from "../state/install-marker";
import { nativeFamilyDigest, nativeServerProfiles } from "../state/servers-native";
import { installPinning } from "./host-pinning";
import { nativeHostPinning } from "./host-pinning-native";
import { unifiedPushDistributor } from "./unified-push";
import type { ServerProfile, SignOutNotice } from "../state/servers";
import type { SignOutOutcome } from "./bearer";
import { SyncRunner, drainLine } from "./drain";
import { idleSpacing, keepDraining, type AppLifecycle } from "./drain-cadence";
import { appActivity, noteActivity } from "./activity";
import { installNetworkReader, networkDoor, networkNow, onNetworkChange } from "./network-door";
import { nativeNetworkReader } from "./network-native";
import { organizeHere, readMailboxes, type OrganizeOutcome } from "./mailboxes";
import {
  connectProfileById,
  connectShellById,
  drainPendingSignOuts,
  drainPendingWakeDrops,
  drainPendingWipes,
  clearUnscopedCalendarCredentials,
  discardAdmission,
  erasePendingCalendarCopies,
  familyReplacedAt,
  signOutNoticeText,
  forgetProfile,
  handoffMinter,
  listHeldStandalone,
  mobileDeviceKind,
  negotiate,
  pairingFetch,
  pairApproved,
  pairForShell,
  pairWithServer,
  probePairing,
  revokeBrowserPair,
  type PairAdmission,
  type PairOutcome,
  type ProbeOutcome,
  type ConnectedSession,
  type Negotiation,
  type PairingEnv,
  type ShellOutcome,
  type ShellSession,
} from "./pairing";
import { awaitBrowserApproval, browserSignInOrigin, probeBrowserSignIn } from "./approval";
import { approvalBrowser } from "./approval-native";
import { resolveApiBase, type BaseVerdict } from "./server-base.js";
import { TransitionGate } from "./transitions";
import { buildCommit } from "../build-info";
import { appRelease } from "./app-release";
import { mailSurfaceOf } from "../shell/mail-surface";
import { pairingDigest } from "../switch/digest";
import { notePairings, switchIntake, switchPlaces, takeUpArrival, type ReceiveDeps } from "../switch/receive";
import { switchNative } from "../switch/switch-native";
import { launchOnlySwitch, siblingOf } from "../variant";
import { APP } from "../variant-native";
import { settleLaunchVerdict } from "../shell/old-copy";
import { nativeShellStores } from "../shell/shell-stores-native";
import { keeperRemembers, purgingShellToo } from "../shell/take-back";

/** The surface this app shows mail in, chosen once by the build and the app it is (`mail-surface.ts`). */
export const MAIL_SURFACE = mailSurfaceOf(process.env.EXPO_PUBLIC_OHMAIL_MAIL_SURFACE, APP);

export type ConnectionState =
  /** The launch instant, before the keystore has answered whether a pairing exists. */
  | { k: "starting" }
  /** No session: nothing paired yet, or the reader disconnected. The connect flow owns the screen. */
  | { k: "idle" }
  /** `migrating`: the engine store's upgrade on a relaunch, as the engine announces it. */
  | { k: "connecting"; origin: string; migrating?: BootMigrating }
  | { k: "live"; session: ConnectedSession }
  /** The shell's web view shows the mail; this side holds the transport and boots no engine. */
  | { k: "shell"; session: ShellSession }
  | { k: "refused"; reason: Refusal }
  /** A mid-use death: the server refused the session's token. One scan re-pairs. */
  | { k: "ended"; reason: Refusal };

export type Attempt = { ok: true } | { ok: false; reason: Refusal };

/** A forget's answer: also the removal that kept the store, nothing removed, with what it would drop. */
export type ForgetAttempt = Attempt | { ok: false; reason: Refusal; settingsKept: SettingsKeptHere };

export interface Connection {
  state: ConnectionState;
  syncing: boolean;
  syncError: RefusalArg | null;
  /** Every pairing on this phone — kept current across pair/forget/switch. */
  profiles: ServerProfile[];
  signOutNotices: (Pick<SignOutNotice, "profileId" | "origin" | "deviceId" | "deviceLabel"> & { canReplace: boolean })[];
  dismissSignOutNotice(profileId: string): Promise<void>;
  /** The active profile id (which row the app boots), or null with nothing paired. */
  activeId: string | null;
  /** The picker's /hello probe — negotiation lives in the seam, screens render the answer. */
  ask(origin: string): Promise<Negotiation>;
  /**
   * Where that server's `/sync` family answers — the origin, or `<origin>/api`. Behind this
   * seam for {@link ask}'s reason, made a rule by the privacy census: a screen reaching for
   * `globalThis.fetch` would put a transport in a UI file, which that scan forbids — the door
   * screen renders the answer and dials nothing. The pairing seam measures again for itself
   * (that is where the value is stored, and where a QR-driven pairing gets it); this call is
   * what lets the door name the answer before a single-use code is spent.
   */
  probeBase(origin: string): Promise<BaseVerdict>;
  /**
   * Ask what is at this address, spending nothing — step one of two. `pin` is the desktop
   * door's key fingerprint out of the pairing link, for an address no certificate authority
   * can vouch for; absent for every origin the platform verifies on its own. A parameter
   * rather than something the seam re-derives, because it comes from the QR the person scanned
   * — that is the whole trust path. The answer is what the confirmation screen renders:
   * nothing is stored, no code is spent, and the token is not even passed — it stays with the
   * screen that scanned it. See `net/pairing.ts#PairAdmission`.
   */
  probePair(origin: string, pin?: string | null): Promise<ProbeOutcome>;
  /**
   * REDEEM A CONFIRMED PAIRING and go live on it — step two. The reason is a showable sentence.
   *
   * Takes the admission {@link Connection.probePair} answered with, so this cannot be reached
   * from a scanned string: the person in between is part of the type.
   */
  pairConfirmed(admission: PairAdmission, token: string): Promise<Attempt>;
  signIn(address: string | null, signal: AbortSignal): Promise<Attempt>;
  /**
   * ADOPT THE MAILBOX THIS PHONE JUST OPENED — the fourth door's second half.
   *
   * The door screen starts the engine and hands the door here; this writes the profile row and goes
   * live on it through the SAME gated connect a paired profile takes, so `welcome.tsx`'s redirect
   * and every screen see one kind of session. The row is written BEFORE the connect, because the
   * connect re-reads it from the keystore by id — a session built over a held object would be live
   * on a mailbox the next launch cannot find.
   */
  openStandalone(door: StandaloneEngine): Promise<Attempt>;
  /**
   * LIST THE STORE A REFUSED CONNECT FOUND, by the engine's account id, where no row names this
   * phone's mailbox (`pairing.ts#listHeldStandalone`). Outside the gate: it opens nothing and must not
   * supersede a connect in flight.
   */
  listHeldStandalone(accountId: string): Promise<void>;
  /** Switch the live session to a stored profile — BY ID; the row is re-read in the gate. */
  switchTo(profileId: string): Promise<Attempt>;
  /**
   * Forget the pairing on this phone — the CREDENTIAL, the MAIL, and the server-side session.
   *
   * Answers an {@link Attempt} rather than `void` because a take-back that could not complete
   * must not be reported as one: `{ok: false}` carries the sentence naming what is still on the
   * device and why, and the deletion stays owed so the next launch retries it. On this phone's own
   * mailbox it stops before deleting the store while the store says what the mailbox does not
   * (`settingsKept`); `anyway` is the person's answer to that, and removes it all the same.
   */
  forget(profileId: string, opts?: { anyway?: boolean }): Promise<ForgetAttempt>;
  /** Confirmed erasures the chooser must skip when transferring legacy queues. */
  erasedCalendarScopes?(): Promise<readonly string[]>;
  /**
   * How many unsent drafts the live session on this profile holds, or `null` when no live session
   * is on it. Forgetting this phone's own mailbox deletes its store, and those drafts are on no
   * server, so the Servers screen asks before it.
   */
  unsentDraftsHere(profileId: string): number | null;
  /** End the session without forgetting the pairing. The mirror stays on disk — that is the point. */
  disconnect(): Promise<void>;
  /**
   * The sync doorbell — the wake channel, the Servers screen and pull-to-refresh all ring
   * this one. The round settles quietly, with a failure's sentence in `syncError`.
   * A caller with a listener hears the server's answer as soon as it arrives and waits for
   * both the answer and the drain. Concurrent calls on one session share the same request.
   */
  syncNow(heard?: RingHeard): Promise<void>;
}

/** What a ring's answer is heard by: `null` is a ring that was refused or has no doorbell. */
export type RingHeard = (ring: PullRing | null) => void;

const ConnectionContext = createContext<Connection | null>(null);

/** Keep approval and sign-out on the native transport that honors a redirect refusal. */
const approvalFetch: NonNullable<PairingEnv["approvalFetchImpl"]> = async (url, init) => {
  const { fetch } = await import("expo/fetch");
  return fetch(url, init as Parameters<typeof fetch>[1]);
};

export function useConnection(): Connection {
  const c = useContext(ConnectionContext);
  if (c === null) throw new Error("useConnection outside ConnectionProvider");
  return c;
}

/**
 * The sentence a transition that lost to a newer one answers.
 *
 * This used to say "never rendered as an error", and the census exempted it on that sentence. Both
 * call sites return it as `{ ok: false, reason: SUPERSEDED() }`, and Connect and Scan render every
 * failed reason — so it could reach a German screen in English. A getter over the deck now, not a
 * captured string: this module is imported long before a language is resolved.
 */
const SUPERSEDED = (): Refusal => refuse("connectSuperseded");

/** React Native's `AppState`, as the drain cadence reads it (`net/drain-cadence.ts`). */
const appLifecycle: AppLifecycle = {
  now: () => AppState.currentState,
  subscribe: (listener) => {
    const sub = AppState.addEventListener("change", listener);
    return () => { sub.remove(); };
  },
};

/**
 * Open it again, and wire it to the app's lifecycle — the relaunch's twin of the door screen.
 * `app/standalone.tsx` adopts the door and starts the organizer session; a relaunch is the
 * same moment with no screen in front of it, and without this the second half was absent — the
 * app organized while open, posted no notification, and handed nothing back on leaving the
 * foreground, the state `background.ts` exists to prevent. Native behind a dynamic import for
 * `local-engine-native.ts`'s reason; `void` because an open mailbox must not wait on a
 * notification; the catch records the restriction rather than swallowing it.
 */
async function reopenWithBackground(
  deps: Parameters<typeof reopenStandaloneMailbox>[0],
): Promise<ReopenOutcome> {
  const opened = await reopenStandaloneMailbox(deps);
  if (!opened.ok) return opened;
  const { door } = opened;
  /* THE LAUNCH THIS SESSION BELONGS TO — the door screen's own reason, one path over. The import
     is not awaited, and a relaunch can still be given up after it: the forget stops this engine,
     and a session raised over it afterwards would refuse the next connect its own. */
  const launch = standaloneLaunchGeneration();
  void import("../engine/organizer-session-native")
    .then((m) => { m.startOrganizerSessionNative(door, launch); })
    .catch(() => { sayOrganizerRestricted(); });
  return opened;
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  /** Where a relaunch's store upgrade is told — set by the connect that is waiting on it, and only then. */
  const migratingSink = useRef<((progress: StoreMigrating) => void) | null>(null);
  const env = useMemo<PairingEnv>(
    // `deviceKind` — what THIS phone is, declared at pairing time so the server's device list
    // and its staleness attribution name the install. `Platform.OS` is read here, in the one
    // RN-world composition, and handed in as a fact — `net/pairing` stays react-native-free.
    () => {
      // THE TLS PIN REGISTRY, INSTALLED BEFORE ANY SESSION EXISTS. `pairing.ts` refuses a
      // same-network pairing while this is absent (`canPin()`), which is the honest failure —
      // so this line running before the first `pair`/`connect` is what makes the feature exist
      // at all, and its absence is a refusal rather than an unpinned connection. `useMemo`'s
      // factory runs during the provider's first render, before any child can call a verb.
      installPinning(nativeHostPinning());
      // THE NETWORK DOOR'S ONE READER, before any surface asks it (`network-door.ts`), and a
      // line per reading so a device run can see the platform speak.
      installNetworkReader(nativeNetworkReader());
      logNetwork(networkNow());
      onNetworkChange(logNetwork);
      const calendarOnly = APP.app === "ohcal";
      return {
        profiles: nativeServerProfiles(),
        approvalFetchImpl: approvalFetch,
        calendar: calendarOnly ? calendarLifecycle() : undefined,
        calendarOnly,
        engineDeps: nativeEngineDeps(),
        deviceKind: mobileDeviceKind(Platform.OS),
        // Named to every server in `x-ohmail-client`: the release `app.json` states (`net/app-release.ts`).
        ...(appRelease() !== undefined ? { clientRelease: appRelease()! } : {}),
        /* The digest a re-pair names the family it replaces by (`previousSession`). */
        familyDigest: nativeFamilyDigest,
        /* THE SHELL'S STORES (its keeper and the web view's copy), paid with every mirror's wipe. Only where the
           shell shows the mail: a build on its own screens never wrote either. */
        ...(MAIL_SURFACE === "shell" ? { shell: nativeShellStores(calendarOnly) } : {}),
        /* THE CONNECTOR, so a forget takes down the wake registration of the pairing it is
           forgetting. Registrations became per-pairing in this slice, so an orphan is now a real
           thing to leave behind — `wake.tsx` sweeps only when the LAST pairing goes, because the
           distributor CHOICE is app-wide. Handed in as a port for the reason every other native
           thing here is: `net/pairing.ts` runs under node in the suite. */
        distributor: unifiedPushDistributor(),
        /* THE MAILBOX ON THIS PHONE. `door()` answers a door press (the screen has already opened
           the engine and `organizer-session.ts` holds it); `reopen()` answers a cold launch, which
           has a profile row and nothing running. Both are ports for `distributor`'s reason — the
           platform's SQLite, its key ring and the install marker are all `-native` modules. */
        standalone: {
          door: organizerDoor,
          /* AND THE MAILBOX ON THIS PHONE LETS GO WHEN THE PHONE GOES SOMEWHERE ELSE. The forget's
             own verb: the claim goes back, the session and its notification stop, the engine
             stops. `buildSession` runs it for any account that is not this door's — see the port. */
          standDownAway: async () => { await endStandaloneHere(); },
          reopen: () => reopenWithBackground({
            startFromSealed: phoneEngineReopen(),
            platform: async () => {
              /* BEHIND A DYNAMIC IMPORT, never at module scope: the expo packages are Flow-typed
                 JavaScript and a static import makes this whole module unloadable by the node-side
                 suite — `servers-native.ts`'s rule. */
              const native = await import("../engine/local-engine-native");
              return native.nativeEnginePlatform();
            },
            machineName: () => PHONE_CLAIM_NAME,
            buildCommit: buildCommit(process.env.EXPO_PUBLIC_COMMIT),
            /* THE SAME ID THE GATE STAMPED. A claim written against a second id is how an install
               reads its own claim as somebody else's; the engine refuses a nameless claimant rather
               than this layer inventing one. */
            installId: async () => (await installGeneration(nativeEngineDeps())) ?? "",
            /* THE ENGINE'S OWN LOG — `engine-log.ts`. A relaunch has no screen in front of it, so
               this is the only place a dial that comes up and then files nothing can be read. */
            logSink: engineLogSink(),
            onMigrating: (progress) => { migratingSink.current?.(progress); },
            /* THE COPY BEFORE THE STORE CROSSES INTO 2.0 (`engine/store-copy.ts`), behind the same dynamic
               import as the platform: a throw refuses the open with the store untouched. */
            beforeMajorUpgrade: async (exec) => {
              const native = (await import("../engine/local-engine-native")) as {
                nativeTakeStoreCopy: (exec: unknown) => Promise<void>;
              };
              await native.nativeTakeStoreCopy(exec);
            },
          }),
          /* AND THE TAKE-BACK'S ENGINE HALF. Behind the same dynamic import the platform is:
             `local-engine-native` reaches expo-sqlite and the keystore, neither loadable by the
             node suite, and the removal is where the store and its key actually go. */
          removeEngine: async () => {
            const native = (await import("../engine/local-engine-native")) as {
              nativeRemoveStandaloneEngine: () => Promise<void>;
            };
            await native.nativeRemoveStandaloneEngine();
          },
        },
      };
    },
    [],
  );
  const gateRef = useRef<TransitionGate | null>(null);
  const gate = (gateRef.current ??= new TransitionGate());
  /** The switch's native module, or null in a build without it (the switch then neither sends nor receives). */
  const switcher = useMemo(() => switchNative(), []);

  /* A SIGN-OUT A SERVER WAS NOT TOLD goes when the network comes back (and at launch, below). */
  useEffect(
    () => onNetworkChange((s) => { if (s === "online") void drainPendingSignOuts(env, { atLaunch: false }); }),
    [env],
  );

  const [state, setState] = useState<ConnectionState>({ k: "starting" });
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [signOutNotices, setSignOutNotices] = useState<Connection["signOutNotices"]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  /* A REFUSAL ARGUMENT, not a sentence — see `drain.ts`. A failed round used to freeze its
     words at the moment it was caught, so the Servers screen kept them across a language
     change. It is worded where it is shown. */
  const [syncError, setSyncError] = useState<RefusalArg | null>(null);

  /**
   * What this layer has decided the connection is — every state change goes through it. As
   * `live.current = state` in the body, the ref moved when React painted; measured on a
   * device: on the standalone door the work after `adopt` settles in microtasks while the
   * paint is a task, so the identity verdict and the consent press both read `connecting` and
   * returned — no first drain, no consent — while every paired door was unaffected and the
   * node suite could not reach the question (`net/decided.ts` carries the measurement).
   * `enter` is the only writer — it records, then paints — and
   * `test/connection-decided-state.test.ts` refuses a state change written any other way.
   */
  const decidedRef = useRef<DecidedState<ConnectionState> | null>(null);
  const live = (decidedRef.current ??= decidedState<ConnectionState>(state, setState));
  const enter = live.enter;
  /**
   * The sync rounds, single-flighted ({@link SyncRunner}) — extracted so the honest-settle
   * and quiet-refusal contracts are testable without this provider. The retry queue is NOT
   * drained in a round: the world layer flushes it after each successful drain (watching
   * `syncing` fall), because terminal outcomes need the toast and the composer ledger, and
   * both live above this provider. See `WorldProvider`'s flush effect and `live.ts#flushQueued`.
   */
  const runnerRef = useRef<SyncRunner | null>(null);
  const runner = (runnerRef.current ??= new SyncRunner({
    syncing: setSyncing,
    error: setSyncError,
    /* THE DRAIN LINE — one per round of record, through the app's one sink (`drain.ts#drainLine`). */
    settled: (outcome) => {
      const at = live.now();
      const door = at.k === "live" && at.session.standalone ? "standalone" : "paired";
      engineLogSink()(drainLine(outcome, door, classifyWindowSyncFailure));
    },
  }));
  const pullFlights = useRef(new WeakMap<ConnectedSession, {
    rang: Promise<PullRing | null>;
    round: Promise<void>;
    complete: Promise<void>;
  }>());
  /** The live session's drain cadence and whose it is — stopped by that session's teardown. */
  const cadence = useRef<{ session: ConnectedSession; stop: () => void } | null>(null);
  /** Unsubscribe from the current session's dead signal on teardown. */
  const offDead = useRef<(() => void) | null>(null);

  const refreshProfiles = useCallback(async () => {
    setProfiles(await env.profiles.list());
    const notices = await env.profiles.unresolvedSignOutNotices().catch(() => []);
    setSignOutNotices(notices.map(({ profileId, origin, deviceId, deviceLabel, previousSession }) => ({
      profileId, origin, deviceId, deviceLabel, canReplace: previousSession !== undefined,
    })));
    setActiveId((await env.profiles.active())?.id ?? null);
    /* EVERY CHANGE OF THE PAIRINGS PASSES HERE, so the switch's provider answers the sibling from today's: this
       app's live pairings by their digests, never an address or an account. */
    if (!launchOnlySwitch(APP)) void notePairings(switcher, env, nativeFamilyDigest);
  }, [env, switcher]);

  /**
   * Leave the live state, then close the mirror once the in-flight drain settles. The round
   * is DISOWNED first (captured for the close-wait, then dropped): the leaving session's
   * sync status — a standing failure sentence, a busy flag mid-round — must not stand as the
   * next session's, and the disowned round's own landing reports nothing.
   */
  const teardown = useCallback((session: ConnectedSession): Promise<void> => {
    offDead.current?.();
    offDead.current = null;
    if (cadence.current?.session === session) {
      cadence.current.stop();
      cadence.current = null;
    }
    const inFlight = runner.inFlight() ?? Promise.resolve();
    runner.disown();
    // RETURNED, not only scheduled. Every caller but one wants this fire-and-forget (leaving a
    // session must not wait on a drain), but `forget` has to DELETE the database this handle is
    // on — and deleting a file underneath an open sqlite handle is the kind of thing that works
    // on one platform and not another, which is the same rule the desktop shell states for its
    // own data directory. So the promise is handed back and exactly one caller awaits it.
    const closed = inFlight.catch(() => undefined).then(() => session.store.close());
    void closed;
    return closed;
  }, [runner]);

  const drain = useCallback(
    (session: ConnectedSession, first: boolean) => runner.run(session.engine, first),
    [runner],
  );

  /**
   * Record the consent for the mailbox this phone opened — the press, and the id it needs.
   * The route is `POST /local/mailboxes/:id/organize` and the id is the engine's, so the roster is
   * read first through the same session. A roster that cannot be read is a refusal with its
   * own sentence, never a silent skip: the defect this closes is a phone that reads its own
   * mailbox and organizes nothing while every surface says it is fine. Nothing here waits on
   * anything; an `authorized` or `already` answer clears the previous attempt's sentence, so
   * a retry that succeeds leaves no stale refusal under a session that is now organizing.
   */
  const consentHere = useCallback(async (session: ConnectedSession | ShellSession): Promise<void> => {
    /** The session this press belongs to is still the one entered, under either surface. */
    const still = (at: ConnectionState): boolean => (at.k === "live" || at.k === "shell") && at.session === session;
    /**
     * THE ID COMES OFF THE DOOR, NOT OVER A REQUEST — the keys of `runtimes().organizer` ARE
     * mailbox ids, and the engine is in this process. This first read the roster over the loopback
     * door and was REFUSED on a device, on the read whose three silent outcomes had already made
     * Settings' panel dark; the engine's own word needs no transport and cannot fail that way.
     *
     * The roster stays as the second answer, for a launch whose engine has not reported a mailbox
     * yet. Neither answering is a sentence, not a silent skip: a phone that reads its own mailbox
     * and organizes nothing while every surface says it is fine is the whole defect.
     */
    const id = standaloneHere()?.id ?? (await readMailboxes(session))?.[0]?.id ?? "";
    if (!still(live.now())) return;
    if (id === "") {
      sayOrganizeRefused(refuse("organizeHereUnreadable"));
      return;
    }
    /* THE PRESS IS A START, through the standing instruction (`pressConsentHere`): the panel reads
       Starting until the claim lands. The request is still this one, stating the screen's rule. */
    const said: { outcome: OrganizeOutcome | null } = { outcome: null };
    await pressConsentHere(async () => {
      said.outcome = await organizeHere(session, id);
      const k = said.outcome.kind;
      return k === "authorized" || k === "already" || k === "held" ? k : "refused";
    });
    const outcome = said.outcome;
    /* Only for THIS session: a verdict that outlives its session (a switch, a forget) must not
       write a sentence under the next one — the rule every other late answer here follows. */
    if (outcome === null || !still(live.now())) return;
    /* NOT `syncError`, which the Servers screen renders inside "Sync failed" — measured on a
       device announcing a sync failure for a mailbox whose sync had not failed. See
       `organizer-session.ts#organizeRefused` for where it goes and why. */
    sayOrganizeRefused(outcome.kind === "refused" ? outcome.reason : null);
    /* AND A LIVE HOLDER IS SAID AT CONNECT, not only under More and Settings: this phone reads. */
    sayReadingAtConnect(outcome.kind === "held" ? { name: outcome.name, consentRecorded: outcome.consentRecorded, joinWaits: outcome.joinWaits } : null);
  }, []);

  /**
   * No drain before the identity verdict (per-account isolation). Rendering the local mirror
   * owes the wire nothing, but a drain moves the mirror: a foreign bearer could answer this
   * mirror's cursor with a 410 (the re-bootstrap wipes the mirror before the drain-time guard
   * sees one entity) or an entity-less page (deletes carry no `accountId`, yet advance the
   * cursor). So every drain waits for {@link ConnectedSession.verifyIdentity} to settle.
   * `verified` and `unverified` both clear it (the desktop-host door has no session read, and
   * a dead network must not brick sync); only a positive `mismatch` refuses, and then no drain
   * ever runs. The map holds the per-session clearance promise so a pull mid-probe chains.
   */
  const clearance = useRef(new WeakMap<ConnectedSession, Promise<boolean>>());

  /**
   * Go live on a session: wire the dead signal FIRST (a probe that dies into a refused
   * rotation must find the listener subscribed — the boot itself no longer touches the wire;
   * `engine/boot.ts`), then run the identity probe, and only on its all-clear the first
   * drain. The mail on screen during the round trip is the device's own cached mirror for
   * this profile; nothing moves it until the verdict is in.
   */
  const adopt = useCallback(
    (session: ConnectedSession) => {
      // Whatever the PREVIOUS session left standing — a failure sentence, a disowned round —
      // is not this session's status. Idempotent; the teardown path already disowned.
      runner.disown();
      /* THE WALL COMES DOWN HERE, and otherwise only on the service's fresh `access: "open"`
         (`net/account.ts`). A later 200 never clears it: a refused account's own doors keep
         answering, and a cached page behind the wall would flicker the app back. Establishing a
         session IS this phone's "sign in again" — pairing, a switch, a reconnect — so it is the
         one gesture that clears. A cold launch reaches this with the slot already empty. */
      clearAccessLock();
      /* THE UPDATE CARD TOO: a session is a server's turn to be judged, and an answer another server gave
         says nothing of this one. */
      clearUpdateAnswer();
      offDead.current?.();
      /* NO DEAD SIGNAL ON THE STANDALONE DOOR, and `null` rather than a subscription that can never
         fire: the engine in this process mints its own bearer per launch, so there is no family for
         a server to judge and no `ended` state this session can reach. A faked manager here would
         have made this line compile and the state unreachable. */
      offDead.current = session.bearer?.onSessionDead((why) => {
        // The server judged this family's token. Render mail no further: tear down and give the
        // person the one sentence every door shows for this — which ends in the remedy, because
        // "signed out" with no way back is what they used to meet (`net/session-death.ts`). The
        // cause goes to the device's log from the registry, which hears every death.
        const closed = teardown(session);
        enter({ k: "ended", reason: deathRefusal(why) });
        if (session.bearer?.removesCopy !== true) {
          void refreshProfiles();
          return;
        }
        /* THE ACCOUNT WAS ERASED, OR THE SERVER REVOKED THIS SESSION BY CODE (Devices, sign out
           everywhere, a credential change): this pairing's copy goes — keystore row, profile, this
           owner's mirror, pin, wake registration — through the Forget verb's own ceremony, once the
           store handle is closed. Nothing to tell the server: the session is already gone there.
           Another profile on this phone is not touched. */
        void forgetProfile(env, session.profile.id, { closed, revoke: async () => true, erased: why === "erased" })
          .catch(() => undefined)
          .then(() => refreshProfiles());
      }) ?? null;
      enter({ k: "live", session });
      // Only a mismatch acts, and only on the session it was asked about — a verdict that
      // outlives its session (a switch, a forget) clears nothing and drains nothing.
      const gate = session.verifyIdentity().then((verdict) => {
        const atVerdict = live.now();
        if (atVerdict.k !== "live" || atVerdict.session !== session) return false;
        if (verdict.kind === "mismatch") {
          teardown(session);
          enter({ k: "refused", reason: verdict.reason });
          return false;
        }
        return true;
      });
      clearance.current.set(session, gate);
      void gate.then((ok) => {
        if (ok) void drain(session, true);
        /* AND EVERY ROUND AFTER IT while the app is in front, behind the same clearance — before
           this nothing drained again until a press or a push wake (`net/drain-cadence.ts`). */
        const atCadence = live.now();
        if (!ok || atCadence.k !== "live" || atCadence.session !== session) return;
        cadence.current?.stop();
        cadence.current = {
          session,
          stop: keepDraining({
            lifecycle: appLifecycle,
            network: networkDoor,
            // An idle paired phone spaces its rounds out; a touch, a wake or a pull brings them back.
            ...idleSpacing(session, appActivity),
            round: () => {
              const atRound = live.now();
              if (atRound.k !== "live" || atRound.session !== session) return Promise.resolve(0);
              /* STOOD DOWN WHILE THE WALL STANDS: every round would be the same 402. */
              if (accessLock() !== null) return Promise.resolve(0);
              return runner.request(session.engine).then(() => runner.failures());
            },
          }),
        };
      });
    },
    [drain, env, refreshProfiles, runner, teardown],
  );

  /**
   * Retire the binding before React removes the WebView, so a pending answer cannot reach the leaving page.
   */
  const leaveShell = useCallback(async (revokeCalendar = true) => {
    const at = live.now();
    if (at.k === "shell") at.session.leave();
    offDead.current?.();
    offDead.current = null;
    return at.k !== "shell" || !revokeCalendar || !env.calendar ||
      await env.calendar.revoke(at.session.profile.id).catch(() => false);
  }, [env, live]);

  const adoptShell = useCallback(
    async (session: ShellSession, stillCurrent: () => boolean) => {
      runner.disown();
      clearAccessLock();
      clearUpdateAnswer();
      offDead.current?.();
      const reviewIdentity = async () => {
        const verdict = await session.verifyIdentity();
        if (verdict.kind === "mismatch") {
          void gate.run(async () => {
            const at = live.now();
            if (at.k !== "shell" || at.session !== session) return;
            await leaveShell();
            enter({ k: "refused", reason: verdict.reason });
          });
        }
        return verdict;
      };
      const offRenewed = session.bearer?.onRenewed(() => { void reviewIdentity(); });
      const offSessionDead = session.bearer?.onSessionDead((why) => {
        void gate.run(async () => {
          const at = live.now();
          if (at.k !== "shell" || at.session !== session) return;
          await leaveShell(why !== "erased");
          enter({ k: "ended", reason: deathRefusal(why) });
          if (session.bearer?.removesCopy === true) {
            await forgetProfile(env, session.profile.id, { revoke: async () => true, erased: why === "erased" })
              .catch(() => undefined);
          }
          await refreshProfiles();
        });
      });
      const unsubscribe = () => { offRenewed?.(); offSessionDead?.(); };
      offDead.current = unsubscribe;
      const identity = reviewIdentity();
      if (env.calendar?.open) {
        const verdict = await identity;
        if (verdict.kind === "calendarUnavailable" && stillCurrent()) {
          session.leave();
          unsubscribe();
          if (offDead.current === unsubscribe) offDead.current = null;
          await env.calendar.close?.().catch(() => false);
          if (stillCurrent()) enter({ k: "refused", reason: refuse("calendarServerUnavailable") });
          return false;
        }
        const mayRecover = stillCurrent() && verdict.kind === "verified" &&
          await calendarProfileMayRecover(env.profiles, session.profile.id);
        if (stillCurrent()) {
          if (mayRecover) {
            await env.calendar.open(session.profile.id).catch(() => undefined);
          } else {
            await env.calendar.close?.().catch(() => false);
          }
        }
        if (!stillCurrent()) {
          session.leave();
          unsubscribe();
          if (offDead.current === unsubscribe) offDead.current = null;
          await env.calendar.revoke(session.profile.id).catch(() => false);
          return false;
        }
      }
      enter({ k: "shell", session });
      return true;
    },
    [env, gate, leaveShell, refreshProfiles, runner],
  );

  const leaveEntered = useCallback(async () => live.now().k !== "shell" || await leaveShell(), [leaveShell]);

  /* THE LIFT RESTARTS THE LOOP at once, from its stored cursors, behind the same clearance. */
  useEffect(() => onAccessLock((facts) => {
    const at = live.now();
    if (facts !== null || at.k !== "live") return;
    const session = at.session;
    void (clearance.current.get(session) ?? Promise.resolve(false)).then((ok) => {
      const atDrain = live.now();
      if (ok && atDrain.k === "live" && atDrain.session === session) void runner.request(session.engine);
    });
  }), [live, runner]);

  /**
   * The one connect body every gated transition shares: teardown, fresh keystore read BY ID,
   * boot, and — only while still the newest request — adoption. A superseded outcome closes
   * its store (the engine never started, so there is no drain to await) and changes nothing.
   */
  const runConnect = useCallback(
    async (id: string, stillCurrent: () => boolean): Promise<Attempt> => {
      // The keystore read comes FIRST, teardown immediately before its own next state: the
      // disown's falling busy edge and the departure from `live` must land in ONE render
      // commit. With an await between them, the world layer would see "drain completed" while
      // the OUTGOING session was still on screen and restart work against it — the retry
      // flush, the folders re-read, an owed drain — racing the scheduled store close.
      const row = (await env.profiles.list()).find((p) => p.id === id);
      { const at = live.now(); if (at.k === "live") teardown(at.session); }
      if (live.now().k === "shell") await leaveEntered();
      // An app that organizes no mailbox (the calendar's) never opens the phone's own engine: such a row is not its.
      if (row === undefined || (!APP.carries.organizes && row.origin === LOCAL_ENGINE_ORIGIN)) {
        if (stillCurrent()) enter({ k: "refused", reason: refuse("notPairedHere") });
        return { ok: false, reason: refuse("notPairedHere") };
      }
      if (stillCurrent()) enter({ k: "connecting", origin: row.origin });
      /* THE STORE'S UPGRADE, onto the connecting state this connect entered and no other: a
         superseded connect, or a state that has moved on (a refusal), is not told. */
      const sink = (progress: StoreMigrating): void => {
        if (!stillCurrent()) return;
        const next = migratingState(live.now(), row.origin, progress, Date.now());
        if (next !== null) enter(next);
      };
      migratingSink.current = sink;
      let outcome: Awaited<ReturnType<typeof connectProfileById>> | ShellOutcome;
      try {
        /* THE SHELL'S OWN WAY IN, chosen once by the build: no engine is booted on this side. */
        outcome = MAIL_SURFACE === "shell" ? await connectShellById(env, id) : await connectProfileById(env, id);
      } finally {
        if (migratingSink.current === sink) migratingSink.current = null;
      }
      await refreshProfiles();
      if (!stillCurrent()) {
        if (outcome.kind === "connected") outcome.session.store.close();
        return { ok: false, reason: SUPERSEDED() };
      }
      if (outcome.kind === "refused" && outcome.died !== "erased" && env.calendar) {
        await env.calendar.revoke(id).catch(() => false);
        if (!stillCurrent()) return { ok: false, reason: SUPERSEDED() };
      }
      if (outcome.kind === "refused" && outcome.died !== undefined) {
        /* THE SLOT'S MANAGER DIED WITH NOBODY LISTENING (a launch's wake drain, a torn-down tree's
           last request): answered as the dead-signal listener answers, with its state and, for a
           death that removes the copy, its Forget — no store was opened, so there is nothing to close. */
        enter({ k: "ended", reason: outcome.reason });
        if (outcome.removesCopy === true) {
          void forgetProfile(env, id, { revoke: async () => true, erased: outcome.died === "erased" })
            .catch(() => undefined)
            .then(() => refreshProfiles());
        }
        return { ok: false, reason: outcome.reason };
      }
      if (outcome.kind === "refused") {
        enter({ k: "refused", reason: outcome.reason });
        return { ok: false, reason: outcome.reason };
      }
      if (outcome.kind === "shell") {
        if (!await adoptShell(outcome.session, stillCurrent)) return { ok: false, reason: SUPERSEDED() };
      } else adopt(outcome.session);
      /**
       * The consent a person gave in this run is made into the request that records it. A mailbox
       * nobody consented to organizing is READ and nothing else — no claim, no `ohmail/*` tree.
       * Every other door records consent from a client; the standalone door's client is the one
       * this arm just built. It is spent against a FINGER: this used to run on every arrival, and on
       * a device that cost the invariant — a plain relaunch stood down and then wrote a fresh
       * `X-Ohmail-Authorized-At`, holding the claim: two organizers, nobody asked. So
       * `takeConsentPress` spends an arm only a person's press in this run can set, a relaunch
       * presses nothing, and own-role resumption runs through the engine's own gate. `void` here.
       */
      /* SPENT FIRST AND UNCONDITIONALLY, so every connect clears it: an arm set by the door
         screen and then followed by a switch to a paired profile must not be left standing for
         whatever connects next. A process restart clears it on its own — module state dies with
         the process, which is what makes "in this run of the app" the real bound. */
      const asked = takeConsentPress();
      if (organizesHere(outcome.session.profile) && asked) void consentHere(outcome.session);
      return { ok: true };
    },
    [adopt, adoptShell, consentHere, env, leaveEntered, refreshProfiles],
  );

  /**
   * THE SWITCH'S RECEIVING SIDE (`switch/receive.ts`), one intake for the provider's life, opened by the launch below
   * once its order has finished. A handoff runs as one transition of this gate and goes live through the same
   * adoption a confirmed pairing does; a place is held for the shell's page of the session it was judged in (the
   * screens draw no place). The mint, when the sibling asks, is the session in front's, on a paired door only.
   */
  const intake = useRef<ReturnType<typeof switchIntake> | null>(null);
  const takeArrival = useRef<() => Promise<unknown>>(async () => undefined);
  takeArrival.current = () => {
    if (switcher === null) return Promise.resolve();
    if (launchOnlySwitch(APP)) {
      return switcher.takeArrival().catch(() => null);
    }
    const deps: ReceiveDeps = {
      env,
      native: switcher,
      from: siblingOf(APP).app,
      surface: MAIL_SURFACE,
      sha256: nativeFamilyDigest,
      transition: (op) => gate.run(op),
      liveDigest: async () => {
        const at = live.now();
        if ((at.k !== "live" && at.k !== "shell") || at.session.standalone) return null;
        return pairingDigest(nativeFamilyDigest, at.session.profile.origin, at.session.profile.accountId);
      },
      minter: () => {
        const at = live.now();
        return at.k === "live" || at.k === "shell" ? handoffMinter(at.session, siblingOf(APP).app) : undefined;
      },
      adopt: async (handed, stillCurrent) => {
        { const at = live.now(); if (at.k === "live") teardown(at.session); }
        if (live.now().k === "shell") await leaveEntered();
        if (!stillCurrent()) {
          if (handed.kind === "paired") handed.session.store.close();
          return;
        }
        if (handed.kind === "shell") await adoptShell(handed.session, stillCurrent);
        else adopt(handed.session);
        void refreshProfiles();
      },
      place: (to) => {
        const at = live.now();
        if (at.k === "shell") switchPlaces.hold(at.session.profile.id, to);
      },
    };
    return takeUpArrival(deps);
  };
  useEffect(() => {
    const opened = switchIntake(switcher, () => takeArrival.current());
    intake.current = opened;
    return () => {
      opened.stop();
      intake.current = null;
    };
  }, [switcher]);

  // The app launch: whichever profile was active reconnects; none means the connect flow.
  // Through the gate like every other transition, so a fast first tap supersedes it cleanly.
  // `starting` holds only until the keystore answers — the gate component renders nothing
  // during it, so a paired phone never flashes the welcome screen on its way to mail.
  //
  // AND THE KEYSTORE'S REFUSAL IS AN ANSWER: a SecureStore read can reject (a damaged or
  // locked keystore), and a boot that only ever left `starting` on success would render the
  // blank launch surface forever. The catch settles into `refused` with the failure in a
  // sentence — the gate routes that to the Servers screen, which shows it and still offers
  // every way to pair.
  useEffect(() => {
    void gate
      .run(async (stillCurrent) => {
        // ── BEFORE A SINGLE PROFILE IS READ ────────────────────────────────────────────────
        //
        // 1. IS THIS THE INSTALL THAT STORED THEM? On iOS the Keychain outlives deleting the
        //    app, so without this a reinstall reopened the mailbox with no ceremony. The
        //    marker lives in the app container, which iOS does remove. See `install-marker.ts`
        //    — including why a marker store that will not open leaves the pairings alone.
        const install = await settleInstallGeneration(
          env.engineDeps,
          // A fresh install's purge takes the shell's keepers and the web view's copies too, before the stamp.
          purgingShellToo(env.profiles, env.shell),
          // THE UPGRADE SENTINEL. A reinstall's container holds no mirror; an update's holds one
          // for every server that has ever synced. Without this, the first launch of the build
          // that introduced the marker would purge every existing pairing on the phone. Under the
          // shell the mirror is handed across and removed; the scope's keeper, in the same
          // container, stands in for it.
          async (profile) => {
            const ownerKey = mirrorOwnerKey(profile.origin, profile.accountId);
            return (await mirrorExists(env.engineDeps, ownerKey)) || (await keeperRemembers(env.shell, ownerKey));
          },
        );
        // The old copy's removal runs only under the verdict that stamped this install (`shell/old-copy.ts`).
        settleLaunchVerdict(install.kind);
        //    A REFUSED PURGE STOPS THE LAUNCH HERE, and this is the arm the verdict exists for.
        //    The container is new, so every stored pairing belongs to an installation that no
        //    longer exists — and the keystore would not give one up. Reading `active()` after
        //    that boots the surviving credential, which is precisely the no-ceremony reinstall
        //    the marker is for: the take-back would have failed AND opened the mailbox. So
        //    nothing below runs, and the gate routes this sentence to the Servers screen.
        //    `unknown` stops here TOO, and the arm below says why. What it does not do is
        //    DELETE — see `install-marker.ts` for why a store that could not be read must leave
        //    the pairings alone rather than act on a guess. Not using them and not destroying
        //    them are different acts, and only the first is safe to take on a maybe.
        if (install.kind === "purge-refused") {
          if (stillCurrent()) enter({ k: "refused", reason: refuse("serversPurgeRefused", install.reason) });
          return;
        }
        //    And `unknown` stops the launch too, without deleting anything. Two different
        //    acts, and this arm does only the second: it does not purge — reading a transient
        //    storage failure as a fresh install would delete every pairing for a reason
        //    unrelated to the person holding the phone — but it may not connect either. On iOS
        //    the keychain outlives an uninstall, so an unverified marker is exactly the state
        //    in which a stranger's reinstall would open somebody's mailbox, and the copy
        //    promises the pairing is discarded before use. Refusing keeps both halves. Not a
        //    hair trigger: the marker rides the same SQLite host every mirror does, so a
        //    launch that cannot open it could not have read any mail either.
        if (install.kind === "unknown") {
          if (stillCurrent()) enter({ k: "refused", reason: refuse("serversInstallUnknown", install.reason) });
          return;
        }
        // 2. FINISH THE FORGETS THAT DID NOT FINISH. A forget writes its intent before it
        //    touches either store, so a kill mid-way leaves the mail owed rather than
        //    stranded — this is where the debt is paid. A refusal keeps the debt.
        const hasErasure = await erasePendingCalendarCopies(env);
        await clearUnscopedCalendarCredentials(env);
        const keepersPrepared = !env.calendarOnly || !env.shell ||
          await env.shell.prepareCalendarKeeper?.().catch(() => false) === true;
        if (env.calendarOnly && (keepersPrepared || hasErasure) && env.shell?.calendarCopiesPrepared?.() === false &&
            (await env.profiles.pendingWipes()).length > 0) {
          if (!stillCurrent()) return;
          // The chooser removes erased mirrors and moves the remaining legacy queues to their keepers.
          enter({ k: "idle" });
          const prepared = await env.shell.waitForCalendarCopies?.();
          if (!stillCurrent()) return;
          if (!prepared) {
            enter({ k: "refused", reason: refuse("calendarCopyRemains") });
            return;
          }
          enter({ k: "starting" });
        }
        if (!keepersPrepared) {
          if (stillCurrent()) enter({ k: "refused", reason: refuse("calendarCopyRemains") });
          return;
        }
        await drainPendingWipes(env);
        //    And the sign-outs a server was not told — a forget's, or one the drain above just
        //    made. Only those that must swap a live pairing's key in go before any session holds
        //    an origin, two seconds at most; the rest go behind the launch, so a server that does
        //    not answer never holds the mail back.
        await drainPendingSignOuts(env, { atLaunch: true });
        const unconfirmed = await env.profiles.unresolvedSignOutNotices().catch(() => []);
        if (unconfirmed.length > 0 && stillCurrent() && Platform.OS !== "web") {
          Alert.alert(Copy.serversSignOutPending,
            unconfirmed.map(({ origin, deviceLabel, deviceId, previousSession }) =>
              signOutNoticeText(origin, deviceLabel, deviceId, previousSession !== undefined)).join("\n\n"));
        }
        void drainPendingSignOuts(env, { atLaunch: false });
        // 3. AND THE WAKE ROWS THIS PHONE OWES SOMEBODY'S SERVER. Same rule as the mirrors: a
        //    take-back the server refused is written down and retried, because the endpoint it
        //    dials is shared with the profile now in use and therefore never lapses on its own.
        //    Awaited so a launch cannot start registering before the old rows are answered for.
        await drainPendingWakeDrops(env);
        /* NO ACTIVE ROW (a Forget or a revoke removed it): this phone's own mailbox opens, if it
           has one, rather than the Servers pane with nothing under it. */
        const marked = await env.profiles.active();
        const active = marked ?? (await env.profiles.list()).find(organizesHere) ?? null;
        if (marked === null && active !== null) await env.profiles.setActive(active.id).catch(() => undefined);
        await refreshProfiles();
        if (!stillCurrent()) return true;
        if (active === null) {
          if (env.calendar?.close) {
            await env.calendar.close().catch(() => false);
            if (!stillCurrent()) return true;
          }
          /* ONLY OUT OF `starting`, read from the DECIDED state rather than from React's
             updater: a tap that has already begun connecting must not be dropped back to idle. */
          if (live.now().k === "starting") enter({ k: "idle" });
          return true;
        }
        await runConnect(active.id, stillCurrent);
        return true;
      })
      /* THE SWITCH'S ARRIVAL IS TAKEN UP ONLY NOW, once the launch order has finished: never by a launch that stopped
         on the install's verdict, nor by one whose keystore could not be read. */
      .then((ordered) => { if (ordered === true) intake.current?.launched(); })
      .catch((err) => {
        /* `starting` only — see the arm above. */
        if (live.now().k === "starting") {
          enter({ k: "refused", reason: refuse("pairingsUnreadable", faultDetail(err)) });
        }
      });
    return () => {
      { const at = live.now(); if (at.k === "live") teardown(at.session); }
    };
    // Mount-only, per provider — and the provider does NOT outlive an activity recreate: the tree
    // is rebuilt in the same runtime and this runs again while the old tree's rotation may still
    // be in flight. `bearer-registry.ts` keeps that to one manager per slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishPair = useCallback(async (
    admission: PairAdmission, pair: (persisting: () => void) => Promise<PairOutcome | ShellOutcome>,
    stillCurrent: () => boolean, browser = false,
  ): Promise<Attempt> => {
    let leaving: Promise<boolean> | undefined;
    let committed = false;
    const startLeaving = () => {
      const at = live.now();
      if (at.k === "live") void teardown(at.session);
      if (at.k === "shell") leaving = leaveEntered();
    };
    const entering = () => {
      committed = true;
      if (stillCurrent()) enter({ k: "connecting", origin: admission.origin });
    };
    if (!browser) {
      startLeaving();
      if (leaving) await leaving;
      entering();
    }
    const outcome = await pair(() => {
      startLeaving();
      entering();
    });
    if (!committed && outcome.kind === "refused") return { ok: false, reason: outcome.reason };
    if (browser && leaving) await leaving;
    await refreshProfiles();
    if (!stillCurrent()) {
      if (outcome.kind === "paired") outcome.session.store.close();
      return { ok: false, reason: SUPERSEDED() };
    }
    if (outcome.kind === "refused") {
      enter({ k: "refused", reason: outcome.reason });
      return { ok: false, reason: outcome.reason };
    }
    if (outcome.kind === "shell") {
      if (!await adoptShell(outcome.session, stillCurrent)) return { ok: false, reason: SUPERSEDED() };
    } else adopt(outcome.session);
    return { ok: true };
  }, [adopt, adoptShell, enter, leaveEntered, refreshProfiles, teardown]);

  const signIn = useCallback((address: string | null, signal: AbortSignal): Promise<Attempt> => {
    const target = browserSignInOrigin(address);
    if ("reason" in target) return Promise.resolve({ ok: false, reason: target.reason });
    return gate.run(async (current) => {
      const stillCurrent = () => current() && !signal.aborted;
      const superseded = (): Attempt => ({ ok: false, reason: SUPERSEDED() });
      if (!stillCurrent()) return superseded();
      const probe = await probeBrowserSignIn(env, target.origin, signal);
      if (probe.kind === "refused") return { ok: false, reason: probe.reason };
      const { admission } = probe;
      if (!stillCurrent()) {
        discardAdmission(admission);
        return superseded();
      }

      const fetchImpl = pairingFetch({ ...env, fetchImpl: approvalFetch });
      const selfHosted = address !== null;
      const kind = mobileDeviceKind(Platform.OS);
      const approved = await awaitBrowserApproval({
        ...approvalBrowser(selfHosted), fetchImpl,
        kind, label: PAIRING_DEVICE_NAMES[kind],
        calendarOnly: env.calendarOnly,
        previousSession: await familyReplacedAt(env, admission.origin),
      }, { origin: admission.origin, selfHosted }, signal);
      if (!approved.ok) {
        if (approved.issued) await revokeBrowserPair(env, admission, approved.issued, fetchImpl);
        discardAdmission(admission);
        return { ok: false, reason: approved.reason };
      }
      if (!stillCurrent()) {
        await revokeBrowserPair(env, admission, approved.approved, fetchImpl);
        discardAdmission(admission);
        return superseded();
      }
      return finishPair(admission, (persisting) => pairApproved(
        env, { admission, approved: approved.approved, scope: approved.scope },
        MAIL_SURFACE, { signal, current, persisting, fetchImpl },
      ), current, true);
    });
  }, [env, finishPair, gate]);

  const api = useMemo<Connection>(
    () => ({
      state,
      syncing,
      syncError,
      profiles,
      signOutNotices,
      dismissSignOutNotice: async (profileId) => {
        await env.profiles.clearSignOutNotice(profileId);
        await refreshProfiles();
      },
      activeId,
      erasedCalendarScopes: async () => {
        const stores = env.shell;
        if (!env.calendarOnly || !stores) return [];
        const wipes = await env.profiles.pendingWipes();
        return Promise.all(wipes.filter((owed) => owed.erased).map((owed) => stores.scopeOf(owed.owner)));
      },
      ask: (origin) => negotiate(pairingFetch(env), origin),
      probeBase: async (origin) => {
        const result = await resolveApiBase(pairingFetch(env), origin, { calendarOnly: env.calendarOnly });
        return env.calendarOnly && result.kind === "refused" && result.reason.say === "baseApiNotFound"
          ? { kind: "refused", reason: refuse("calendarServerUnavailable") }
          : result;
      },
      /* The probe takes no gate turn and tears nothing down: it spends nothing, and the one
         thing it must install to dial — the code's key — is a lease the screens hand back
         (`discardAdmission`). A person who looks at the confirmation and presses Back is left
         exactly where they were, still paired with whatever they were paired with. */
      probePair: (origin, pin) => probePairing(env, { origin, pin: pin ?? null }),
      pairConfirmed: (admission, token) =>
        gate.run((stillCurrent) => finishPair(admission, () => MAIL_SURFACE === "shell"
          ? pairForShell(env, { admission, token })
          : pairWithServer(env, { admission, token }), stillCurrent)),
      signIn,
      openStandalone: (door) =>
        gate.run(async (stillCurrent) => {
          // The calendar's app organizes no mailbox: its only ways in are a server and a paired computer.
          if (!APP.carries.organizes) return { ok: false, reason: refuse("notPairedHere") };
          { const at = live.now(); if (at.k === "live") teardown(at.session); }
          if (live.now().k === "shell") await leaveEntered();
          if (stillCurrent()) enter({ k: "connecting", origin: LOCAL_ENGINE_ORIGIN });
          /* HELD BEFORE THE ROW IS WRITTEN, so the connect below finds it. `holdStandaloneDoor` is
             first-start-wins: a second press on a phone that already has an engine keeps the one
             that is running, and the row it writes is the same row (same origin, same account). */
          holdStandaloneDoor(door);
          let row;
          try {
            row = await env.profiles.addStandalone({
              origin: LOCAL_ENGINE_ORIGIN,
              /* WHAT THIS DOOR IS, in the vocabulary `/hello` uses for it. The chooser reads the
                 ORIGIN to tell this row from a pairing, never the flavor. */
              flavor: "local",
              /* THE ENGINE'S OWN ACCOUNT. The mirror is keyed by it, so it comes from the thing
                 serving the mail — see `StandaloneEngine.accountId`. */
              accountId: door.accountId,
            });
          } catch (err) {
            /* ══ THE KEYSTORE REFUSED TO RECORD THE MAILBOX, AND THIS IS THE ONE EXIT ═════════
               The engine was left RUNNING here, with the door and the session it had just been
               given, and only the sentence changed: the next Connect opened a second engine over
               the same device store — two organizers of one mailbox, the invariant this app lives
               under — because `holdStandaloneDoor` and `startOrganizerSession` are both
               first-start-wins and decline the newcomer silently. So the refusal undoes the
               launch: the claim goes back, the session and the engine stop, and the credential
               this launch sealed is discarded so the next press dials what is on the form. */
            await discardStandaloneLaunch();
            const reason = refuse("standaloneNotStored", faultDetail(err));
            if (stillCurrent()) enter({ k: "refused", reason });
            return { ok: false, reason };
          }
          await refreshProfiles();
          return runConnect(row.id, stillCurrent);
        }),
      listHeldStandalone: async (accountId) => {
        await listHeldStandalone(env, accountId);
        await refreshProfiles();
      },
      switchTo: (profileId) =>
        gate.run(async (stillCurrent) => {
          if (env.calendar && !await leaveEntered()) return { ok: false, reason: refuse("calendarCopyRemains") };
          try {
            await env.profiles.setActive(profileId);
          } catch (err) {
            /* The platform's own words, quoted — the diagnostic rule, now expressed as a key. */
            return { ok: false, reason: refuse("verbatimDetail", faultDetail(err)) };
          }
          await refreshProfiles();
          return runConnect(profileId, stillCurrent);
        }),
      forget: (profileId, opts) =>
        gate.run(async (): Promise<ForgetAttempt> => {
          // THE CEREMONY LIVES AT THE SEAM (`pairing.ts#forgetProfile`) — this provider owns
          // only what is React: leaving the live state, and closing the store handle whose
          // database the seam is about to delete. Everything a test would want to assert about
          // a take-back is therefore assertable without rendering a component.
          let revokeLive: (() => Promise<SignOutOutcome>) | null = null;
          let closed: Promise<void> = Promise.resolve();
          let beforeForget: (() => Promise<void>) | undefined;
          /* ── FORGETTING THIS PHONE'S OWN MAILBOX IS ONE VERB WITH THREE EFFECTS ─────────────
             The claim goes back, the session and its notification stop, and the ENGINE stops —
             `endStandaloneHere`, before the row goes, because every one of them needs the engine
             that the row names. Removing the row alone would leave a phone organizing a mailbox
             nothing on the chooser mentions, with a notification standing over it. */
          const row = (await env.profiles.list()).find((p) => p.id === profileId);
          /* ── AND WHETHER THE CLAIM ACTUALLY WENT IS THE THING THE ANSWER IS ABOUT ───────────
             `endStandaloneHere`'s hand-back was swallowed and this reported a forget over it, so
             a release the mail server never confirmed left the mailbox blocked to the person's
             other machine for the staleness window — by an install that no longer lists it and
             has no verb left to release it. The row still goes: what changes is the sentence. */
          const ended = row?.origin === LOCAL_ENGINE_ORIGIN ? await endStandaloneForRemoval() : null;
          const claimWentBack = ended?.released ?? true;
          const atForget = live.now();
          if ((atForget.k === "live" || atForget.k === "shell") && atForget.session.profile.id === profileId) {
            const bearer = atForget.session.bearer;
            /* NO LOGOUT WITHOUT A MANAGER — the standalone door's session has none, and the seam
               answers `told` for it on its own (`pairing.ts#forgetProfile`). */
            revokeLive = bearer === null ? null : () => bearer.signOut();
            if (env.calendarOnly && atForget.k === "shell") {
              beforeForget = async () => {
                await leaveShell();
                enter({ k: "idle" });
              };
            } else {
              if (atForget.k === "live") closed = teardown(atForget.session);
              else await leaveShell();
              enter({ k: "idle" });
            }
          } else if (atForget.k === "connecting") {
            // SETTLE a state no later transition will. Every other transition ends by setting
            // its own state; forget was the one that could leave a SUPERSEDED boot's
            // `connecting` standing — tap a profile, tap Forget before the boot settles, and
            // the stale runConnect (correctly) adopts nothing while forget (wrongly) said
            // nothing either: the gate rendered "connecting" forever. Requesting forget made
            // that boot stale, and the gate serializes, so nothing else is in flight — idle
            // is the truth. `refused`/`ended` stay: they are terminal, and their sentence is
            // the reason the Servers screen exists.
            enter({ k: "idle" });
          }
          /* What the hand-back left only in the store keeps it, until the person answers (`anyway`). */
          const outcome = await forgetProfile(env, profileId, {
            closed, beforeForget, revoke: revokeLive, settingsKept: ended?.settingsKept ?? null, anyway: opts?.anyway === true,
          });
          await refreshProfiles();
          if (outcome.kind === "kept") {
            /* The Servers screen's confirm says the same. A claim this hand-back could not give back is said by the
               Remove anyway that follows: its end holds no door and answers for it. */
            const reason = outcome.settings === "answer" ? refuse("serversStopHereSettingsAnswer")
              : outcome.settings === "newer" ? refuse("serversStopHereSettingsNewer")
              : outcome.settings === "unsaved" ? refuse("serversStopHereSettingsUnsaved")
              : refuse("serversStopHereSettingsUnknown");
            return { ok: false, reason, settingsKept: outcome.settings };
          }
          if (outcome.kind !== "forgotten") return { ok: false, reason: outcome.reason };
          /* EVERYTHING LOCAL IS GONE AND SOMETHING IS NOT — `ForgetOutcome.partial`'s own shape,
             which the mail-remains and server-not-told arms already use. The claim is the third. */
          return claimWentBack
            ? { ok: true }
            : { ok: false, reason: refuse("forgetClaimStands", CLAIM_LAPSES_AFTER_MINUTES) };
        }),
      unsentDraftsHere: (profileId) => {
        const at = live.now();
        /* UNDER THE SHELL the page's engine holds the drafts and this side cannot count them: null,
           which the Servers screen reads as "may hold unsent words" and asks before removing. */
        if (at.k !== "live" || at.session.profile.id !== profileId) return null;
        return unsentDraftsOf(at.session.engine.read()).length;
      },
      disconnect: () =>
        gate.run(async () => {
          { const at = live.now(); if (at.k === "live") teardown(at.session); }
          const cleared = live.now().k !== "shell" || await leaveEntered();
          enter(cleared ? { k: "idle" } : { k: "refused", reason: refuse("calendarCopyRemains") });
          setSyncError(null);
        }),
      syncNow: (heard) => {
        // Pull behind the same identity verdict as the first drain, and join a pull
        // the drawer, list or wake already asked this session to run.
        noteActivity();
        const atSync = live.now();
        if (atSync.k !== "live") return Promise.resolve();
        const session = atSync.session;
        const gate = clearance.current.get(session) ?? Promise.resolve(false);
        return gate.then((ok) => {
          const atDrain = live.now();
          if (!ok || atDrain.k !== "live" || atDrain.session !== session) return;
          const existing = pullFlights.current.get(session);
          let flight = existing;
          if (flight === undefined) {
            const rang = session.engine.requestPull();
            const round = runner.request(session.engine);
            const complete = Promise.allSettled([rang, round]).then(() => { pullFlights.current.delete(session); });
            flight = { rang, round, complete };
            pullFlights.current.set(session, flight);
            // Two quiet follow-up rounds pick up what the worker's requested scan writes.
            void rang.then((r) => {
              if (!r || r.requested === 0) return;
              for (const delayMs of [4_000, 10_000]) {
                setTimeout(() => {
                  const atRound = live.now();
                  if (atRound.k === "live" && atRound.session === session) {
                    void runner.request(session.engine);
                  }
                }, delayMs);
              }
            }, () => undefined);
          }
          // A button can hand its press event in this place. For the pull listener, the
          // waiting mark stands until both the real request and the joined drain settle.
          if (typeof heard !== "function") return existing ? runner.request(session.engine) : flight.round;
          const answered = flight.rang.then((answer) => {
            const atAnswer = live.now();
            if (atAnswer.k === "live" && atAnswer.session === session) heard(answer);
          }).catch(() => undefined);
          return flight.complete.then(() => answered);
        });
      },
    }),
    [
      state, syncing, syncError, profiles, signOutNotices, activeId, adopt, adoptShell, drain, env, gate, leaveEntered, leaveShell,
      finishPair, refreshProfiles, runConnect, runner, signIn, teardown,
    ],
  );

  return <ConnectionContext.Provider value={api}>{children}</ConnectionContext.Provider>;
}
