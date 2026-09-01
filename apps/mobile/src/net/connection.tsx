/**
 * THE CONNECTION LAYER — one live session for the whole app, as a React context.
 *
 * This is the surface the real mail screens consume: `useConnection()` answers the current
 * state (idle, a connecting/live session, a refusal, or an ENDED session), and the
 * live state carries the engine + store the screens subscribe to. The connection screens (the
 * picker, the scanner, the manual fallback) drive the transitions; nothing else in the app
 * touches the network seam.
 *
 * Discipline carried from the first connect screen, because the hazards did not move:
 *
 *  · **teardown awaits the in-flight drain.** Closing a mirror under a live drain does not
 *    stop it — the engine's next flush would reopen the database through the store's own
 *    opener and keep issuing bearer-carrying pages after the app said it disconnected.
 *    Leaving the live state stops NEW drains; the await bounds the one already in the air.
 *  · **a refused boot is a refusal, not a degraded mode** — there is no engine behind the
 *    refused state and nothing pretending to be one (`boot.ts` owns that rule).
 *  · **a failed sync re-hydrates** so the torn-flush guard's refusal window closes before
 *    the retry this layer offers.
 *
 * Two further rules, both about the family's ONE refresh token:
 *
 *  · **every transition runs through the {@link TransitionGate}** — serialized, last-wins.
 *    Two overlapping taps would otherwise build two managers on one profile, each presenting
 *    the same refresh token, and strict reuse would revoke a valid pairing. A superseded
 *    transition's outcome is torn down (store closed, engine never started), never adopted.
 *  · **profiles cross this layer as IDS, never as held objects.** A row in React state goes
 *    stale the moment a rotation lands — its refreshToken is the CONSUMED one — so every
 *    connect re-reads the keystore row inside the gate (`connectProfileById`).
 *
 * The manager's dead signal — the server REFUSED the family's token (a desktop revoke, a
 * reuse judgment) — tears the session down and lands on `ended` with the one true remedy in
 * words: scan a fresh QR. A network failure never lands here; the manager clears nothing on
 * anything short of a judgment.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { Copy } from "../copy";
import { mirrorExists, mirrorOwnerKey } from "../engine/boot";
import { nativeEngineDeps } from "../engine/native";
import { settleInstallGeneration } from "../state/install-marker";
import { nativeServerProfiles } from "../state/servers-native";
import { installPinning } from "./host-pinning";
import { nativeHostPinning } from "./host-pinning-native";
import type { ServerProfile } from "../state/servers";
import type { FetchLike } from "./bearer";
import { SyncRunner } from "./drain";
import {
  connectProfileById,
  drainPendingWakeDrops,
  drainPendingWipes,
  forgetProfile,
  mobileDeviceKind,
  negotiate,
  pairWithServer,
  type ConnectedSession,
  type Negotiation,
  type PairingEnv,
} from "./pairing";
import { resolveApiBase, type BaseVerdict } from "./server-base.js";
import { TransitionGate } from "./transitions";

export type ConnectionState =
  /** The launch instant, before the keystore has answered whether a pairing exists. */
  | { k: "starting" }
  /** No session: nothing paired yet, or the reader disconnected. The connect flow owns the screen. */
  | { k: "idle" }
  | { k: "connecting"; origin: string }
  | { k: "live"; session: ConnectedSession }
  | { k: "refused"; reason: string }
  /** A mid-use death: the server refused the session's token. One scan re-pairs. */
  | { k: "ended"; reason: string };

export type Attempt = { ok: true } | { ok: false; reason: string };

export interface Connection {
  state: ConnectionState;
  syncing: boolean;
  syncError: string | null;
  /** Every pairing on this phone — kept current across pair/forget/switch. */
  profiles: ServerProfile[];
  /** The active profile id (which row the app boots), or null with nothing paired. */
  activeId: string | null;
  /** The picker's /hello probe — negotiation lives in the seam, screens render the answer. */
  ask(origin: string): Promise<Negotiation>;
  /**
   * WHERE THAT SERVER'S `/sync` FAMILY ANSWERS — the origin, or `<origin>/api`.
   *
   * Behind this seam for {@link ask}'s reason, and the privacy census is what makes it a rule
   * rather than a preference: a screen that reached for `globalThis.fetch` to run this itself
   * would put a transport in a UI file, which is exactly what that scan forbids. The door screen
   * renders the answer and dials nothing.
   *
   * The PAIRING seam measures again for itself — that is where the value is stored, and where a
   * QR-driven pairing that never opened this screen gets it too. This call is what lets the door
   * NAME the answer before a single-use code is spent.
   */
  probeBase(origin: string): Promise<BaseVerdict>;
  /** Redeem a scanned/typed pairing and go live on it. The reason is a showable sentence. */
  /**
   * `pin` is the desktop door's key fingerprint out of the pairing link, for an address no
   * certificate authority can vouch for. Absent for every origin the platform verifies on its
   * own. It is a parameter rather than something the seam re-derives because it comes from the
   * QR the person scanned — that is the whole trust path.
   */
  pair(origin: string, token: string, pin?: string | null): Promise<Attempt>;
  /** Switch the live session to a stored profile — BY ID; the row is re-read in the gate. */
  switchTo(profileId: string): Promise<Attempt>;
  /**
   * Forget the pairing on this phone — the CREDENTIAL, the MAIL, and the server-side session.
   *
   * Answers an {@link Attempt} rather than `void` because a take-back that could not complete
   * must not be reported as one: `{ok: false}` carries the sentence naming what is still on the
   * device and why, and the deletion stays owed so the next launch retries it.
   */
  forget(profileId: string): Promise<Attempt>;
  /** End the session without forgetting the pairing. The mirror stays on disk — that is the point. */
  disconnect(): Promise<void>;
  /**
   * The sync doorbell — the wake channel, the Servers screen and pull-to-refresh all ring
   * this one. Resolves when the sync round actually settles (a round already in flight is
   * JOINED, not doubled — the engine's own poll/wake doctrine), which is what lets a pull
   * spinner end honestly; a failure resolves too, with the sentence in `syncError`.
   */
  syncNow(): Promise<void>;
}

const ConnectionContext = createContext<Connection | null>(null);

export function useConnection(): Connection {
  const c = useContext(ConnectionContext);
  if (c === null) throw new Error("useConnection outside ConnectionProvider");
  return c;
}

/** The sentence a transition that lost to a newer one answers — never rendered as an error. */
const SUPERSEDED = "superseded by a newer connection attempt";

export function ConnectionProvider({ children }: { children: ReactNode }) {
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
      return {
        profiles: nativeServerProfiles(),
        engineDeps: nativeEngineDeps(),
        deviceKind: mobileDeviceKind(Platform.OS),
      };
    },
    [],
  );
  const gateRef = useRef<TransitionGate | null>(null);
  const gate = (gateRef.current ??= new TransitionGate());

  const [state, setState] = useState<ConnectionState>({ k: "starting" });
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const live = useRef<ConnectionState>(state);
  live.current = state;
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
  }));
  /** Unsubscribe from the current session's dead signal on teardown. */
  const offDead = useRef<(() => void) | null>(null);

  const refreshProfiles = useCallback(async () => {
    setProfiles(await env.profiles.list());
    setActiveId((await env.profiles.active())?.id ?? null);
  }, [env]);

  /**
   * Leave the live state, then close the mirror once the in-flight drain settles. The round
   * is DISOWNED first (captured for the close-wait, then dropped): the leaving session's
   * sync status — a standing failure sentence, a busy flag mid-round — must not stand as the
   * next session's, and the disowned round's own landing reports nothing.
   */
  const teardown = useCallback((session: ConnectedSession): Promise<void> => {
    offDead.current?.();
    offDead.current = null;
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
   * ── NO DRAIN BEFORE THE IDENTITY VERDICT (per-account isolation) ──────────────────────────
   *
   * Rendering the local mirror owes the wire nothing, but a DRAIN moves the mirror: a bearer
   * belonging to another account could answer this mirror's cursor with a 410 (the engine's
   * re-bootstrap WIPES the mirror before the drain-time guard could see one entity) or with
   * an entity-less page (deletes and empty pages carry no `accountId` for the guard to
   * refuse, yet advance the cursor). So every drain — the session's first, a pull, a wake, a
   * folders-flip — waits for {@link ConnectedSession.verifyIdentity} to settle. `verified`
   * and `unverified` both clear it (the desktop-host door has no session read, and a dead
   * network must not brick sync — the entity-carrying pages stay guarded as before); only a
   * positive `mismatch` refuses, and then no drain ever runs. The map holds the per-session
   * clearance promise so a pull landing mid-probe CHAINS instead of racing it.
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
      offDead.current?.();
      offDead.current = session.bearer.onSessionDead(() => {
        // The server judged this family's token — a revoke or a reuse-past. Render mail no
        // further: tear down and say the one-gesture remedy.
        teardown(session);
        setState({ k: "ended", reason: "this pairing ended on the server — scan a fresh QR to pair again" });
        void refreshProfiles();
      });
      setState({ k: "live", session });
      // Only a mismatch acts, and only on the session it was asked about — a verdict that
      // outlives its session (a switch, a forget) clears nothing and drains nothing.
      const gate = session.verifyIdentity().then((verdict) => {
        if (live.current.k !== "live" || live.current.session !== session) return false;
        if (verdict.kind === "mismatch") {
          teardown(session);
          setState({ k: "refused", reason: verdict.reason });
          return false;
        }
        return true;
      });
      clearance.current.set(session, gate);
      void gate.then((ok) => {
        if (ok) void drain(session, true);
      });
    },
    [drain, refreshProfiles, runner, teardown],
  );

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
      if (live.current.k === "live") teardown(live.current.session);
      if (row === undefined) {
        if (stillCurrent()) setState({ k: "refused", reason: "that server is no longer paired on this phone" });
        return { ok: false, reason: "that server is no longer paired on this phone" };
      }
      if (stillCurrent()) setState({ k: "connecting", origin: row.origin });
      const outcome = await connectProfileById(env, id);
      await refreshProfiles();
      if (!stillCurrent()) {
        if (outcome.kind === "connected") outcome.session.store.close();
        return { ok: false, reason: SUPERSEDED };
      }
      if (outcome.kind === "refused") {
        setState({ k: "refused", reason: outcome.reason });
        return { ok: false, reason: outcome.reason };
      }
      adopt(outcome.session);
      return { ok: true };
    },
    [adopt, env, refreshProfiles, teardown],
  );

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
          env.profiles,
          // THE UPGRADE SENTINEL. A reinstall's container holds no mirror; an update's holds one
          // for every server that has ever synced. Without this, the first launch of the build
          // that introduced the marker would purge every existing pairing on the phone.
          (profile) => mirrorExists(env.engineDeps, mirrorOwnerKey(profile.origin, profile.accountId)),
        );
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
          if (stillCurrent()) setState({ k: "refused", reason: Copy.serversPurgeRefused(install.reason) });
          return;
        }
        //    AND `unknown` STOPS THE LAUNCH TOO, without deleting anything.
        //
        //    These are two different acts and this arm does only the second. It does NOT purge:
        //    reading a transient storage failure as a fresh install would delete every pairing
        //    on the phone for a reason unrelated to the person holding it. But it may not CONNECT
        //    either — on iOS the keychain outlives an uninstall, so an unverified marker is
        //    exactly the state in which a stranger's reinstall would open somebody's mailbox, and
        //    the app's own copy promises the pairing is discarded before use. Refusing keeps both
        //    halves of that promise: nothing is used, and nothing is destroyed.
        //
        //    In practice this is not a hair trigger. The marker rides the same SQLite host every
        //    mirror does, so a launch that cannot open it is a launch that could not have read
        //    any mail either.
        if (install.kind === "unknown") {
          if (stillCurrent()) setState({ k: "refused", reason: Copy.serversInstallUnknown(install.reason) });
          return;
        }
        // 2. FINISH THE FORGETS THAT DID NOT FINISH. A forget writes its intent before it
        //    touches either store, so a kill mid-way leaves the mail owed rather than
        //    stranded — this is where the debt is paid. A refusal keeps the debt.
        await drainPendingWipes(env);
        // 3. AND THE WAKE ROWS THIS PHONE OWES SOMEBODY'S SERVER. Same rule as the mirrors: a
        //    take-back the server refused is written down and retried, because the endpoint it
        //    dials is shared with the profile now in use and therefore never lapses on its own.
        //    Awaited so a launch cannot start registering before the old rows are answered for.
        await drainPendingWakeDrops(env);
        await refreshProfiles();
        const active = await env.profiles.active();
        if (!stillCurrent()) return;
        if (active === null) {
          setState((s) => (s.k === "starting" ? { k: "idle" } : s));
          return;
        }
        await runConnect(active.id, stillCurrent);
      })
      .catch((err) => {
        setState((s) =>
          s.k === "starting"
            ? { k: "refused", reason: `could not read this phone's stored pairings — ${String(err)}` }
            : s,
        );
      });
    return () => {
      if (live.current.k === "live") teardown(live.current.session);
    };
    // Mount-only: the provider outlives every screen; later transitions come through the API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const api = useMemo<Connection>(
    () => ({
      state,
      syncing,
      syncError,
      profiles,
      activeId,
      ask: (origin) => negotiate(globalThis.fetch.bind(globalThis) as FetchLike, origin),
      probeBase: (origin) => resolveApiBase(globalThis.fetch.bind(globalThis) as FetchLike, origin),
      pair: (origin, token, pin) =>
        gate.run(async (stillCurrent) => {
          if (live.current.k === "live") teardown(live.current.session);
          if (stillCurrent()) setState({ k: "connecting", origin });
          const outcome = await pairWithServer(env, { origin, token, pin: pin ?? null });
          await refreshProfiles();
          if (!stillCurrent()) {
            if (outcome.kind === "paired") outcome.session.store.close();
            return { ok: false, reason: SUPERSEDED };
          }
          if (outcome.kind === "refused") {
            setState({ k: "refused", reason: outcome.reason });
            return { ok: false, reason: outcome.reason };
          }
          adopt(outcome.session);
          return { ok: true };
        }),
      switchTo: (profileId) =>
        gate.run(async (stillCurrent) => {
          try {
            await env.profiles.setActive(profileId);
          } catch (err) {
            return { ok: false, reason: String(err) };
          }
          await refreshProfiles();
          return runConnect(profileId, stillCurrent);
        }),
      forget: (profileId) =>
        gate.run(async () => {
          // THE CEREMONY LIVES AT THE SEAM (`pairing.ts#forgetProfile`) — this provider owns
          // only what is React: leaving the live state, and closing the store handle whose
          // database the seam is about to delete. Everything a test would want to assert about
          // a take-back is therefore assertable without rendering a component.
          let revokeLive: (() => Promise<boolean>) | null = null;
          let closed: Promise<void> = Promise.resolve();
          if (live.current.k === "live" && live.current.session.profile.id === profileId) {
            const bearer = live.current.session.bearer;
            revokeLive = () => bearer.logout();
            closed = teardown(live.current.session);
            setState({ k: "idle" });
          } else if (live.current.k === "connecting") {
            // SETTLE a state no later transition will. Every other transition ends by setting
            // its own state; forget was the one that could leave a SUPERSEDED boot's
            // `connecting` standing — tap a profile, tap Forget before the boot settles, and
            // the stale runConnect (correctly) adopts nothing while forget (wrongly) said
            // nothing either: the gate rendered "connecting" forever. Requesting forget made
            // that boot stale, and the gate serializes, so nothing else is in flight — idle
            // is the truth. `refused`/`ended` stay: they are terminal, and their sentence is
            // the reason the Servers screen exists.
            setState({ k: "idle" });
          }
          const outcome = await forgetProfile(env, profileId, { closed, revoke: revokeLive });
          await refreshProfiles();
          return outcome.kind === "forgotten" ? { ok: true } : { ok: false, reason: outcome.reason };
        }),
      disconnect: () =>
        gate.run(async () => {
          if (live.current.k === "live") teardown(live.current.session);
          setState({ k: "idle" });
          setSyncError(null);
        }),
      syncNow: () => {
        // Not live ⇒ nothing to sync, settled already. Live ⇒ behind the session's identity
        // clearance (see `clearance` — no drain may move the mirror before the verdict), the
        // runner joins the round in flight or starts one, and the returned promise IS that
        // round's completion — the honest settle a pull spinner renders on. A pull landing
        // mid-probe chains on the verdict: the first drain starts the instant it clears (the
        // adopt continuation registered first, so this one joins that very round).
        if (live.current.k !== "live") return Promise.resolve();
        const session = live.current.session;
        const gate = clearance.current.get(session) ?? Promise.resolve(false);
        return gate.then((ok) => {
          if (!ok || live.current.k !== "live" || live.current.session !== session) return;
          // ── RING THE WORKER'S DOORBELL, THEN DRAIN ────────────────────────────────────────
          //
          // The drain below answers "what does the worker already have"; the person pulling was
          // usually just told "I sent it", which is about mail the worker has NOT looked at yet.
          // `requestPull` stamps `sync_requested_at` so the worker scans those mailboxes now
          // (seconds) instead of at its poll rotation's leisure. It never throws — an absent or
          // refused doorbell degrades to exactly the pull-to-refresh this always was.
          //
          // THE RACE, AND THE BOUNDED FOLLOW-UPS. The first drain almost always finishes before
          // the worker's scan commits anything (the kick scan runs every ~3 s and the IMAP visit
          // takes a few more), so a pull that stopped at one round would settle its spinner on a
          // mirror the doorbell had not yet filled. Two quiet follow-up rounds — no spinner, the
          // runner coalesces them onto anything already in flight — pick up what the scan wrote.
          // Bounded at two per gesture, guarded on the session still being the live one, so a
          // held-down refresh cannot stack unbounded rounds.
          const rang = session.engine.requestPull();
          const round = runner.request(session.engine);
          void rang.then((r) => {
            if (!r || r.requested === 0) return;
            for (const delayMs of [4_000, 10_000]) {
              setTimeout(() => {
                if (live.current.k === "live" && live.current.session === session) {
                  void runner.request(session.engine);
                }
              }, delayMs);
            }
          });
          return round;
        });
      },
    }),
    [state, syncing, syncError, profiles, activeId, adopt, drain, env, gate, refreshProfiles, runConnect, runner, teardown],
  );

  return <ConnectionContext.Provider value={api}>{children}</ConnectionContext.Provider>;
}
