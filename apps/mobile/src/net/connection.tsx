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
import { nativeEngineDeps } from "../engine/native";
import { nativeServerProfiles } from "../state/servers-native";
import type { ServerProfile } from "../state/servers";
import type { FetchLike } from "./bearer";
import {
  connectProfileById,
  negotiate,
  pairWithServer,
  revokeProfile,
  type ConnectedSession,
  type Negotiation,
  type PairingEnv,
} from "./pairing";
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
  /** Redeem a scanned/typed pairing and go live on it. The reason is a showable sentence. */
  pair(origin: string, token: string): Promise<Attempt>;
  /** Switch the live session to a stored profile — BY ID; the row is re-read in the gate. */
  switchTo(profileId: string): Promise<Attempt>;
  /** Forget the pairing on this phone AND revoke it server-side (best-effort). */
  forget(profileId: string): Promise<void>;
  /** End the session without forgetting the pairing. The mirror stays on disk — that is the point. */
  disconnect(): Promise<void>;
  syncNow(): void;
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
    () => ({ profiles: nativeServerProfiles(), engineDeps: nativeEngineDeps() }),
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
  /** The in-flight drain, so teardown can WAIT for it (the header's first discipline). */
  const pending = useRef<Promise<void> | null>(null);
  /** Unsubscribe from the current session's dead signal on teardown. */
  const offDead = useRef<(() => void) | null>(null);

  const refreshProfiles = useCallback(async () => {
    setProfiles(await env.profiles.list());
    setActiveId((await env.profiles.active())?.id ?? null);
  }, [env]);

  /** Leave the live state, then close the mirror once the in-flight drain settles. */
  const teardown = useCallback((session: ConnectedSession) => {
    offDead.current?.();
    offDead.current = null;
    const inFlight = pending.current ?? Promise.resolve();
    void inFlight.catch(() => undefined).then(() => session.store.close());
  }, []);

  const drain = useCallback(async (session: ConnectedSession, first: boolean) => {
    setSyncing(true);
    setSyncError(null);
    const run = (async () => {
      try {
        await (first ? session.engine.start() : session.engine.syncOnce());
        // THE RECONNECT PATH DRAINS THE RETRY QUEUE. A retryable rejection parks the
        // mutation on the engine's queue under its Idempotency-Key, and `flushPending` had
        // NO caller in this app — a queued intent (a send, a triage press taken offline)
        // stood forever. A successful drain is the proof the server is reachable again, so
        // the queue retries HERE, with the same keys, which is what makes the retry unable
        // to double-deliver. Failures go back on the queue; the next drain tries again.
        if (session.engine.pendingMutations().length > 0) {
          await session.engine.flushPending().catch(() => undefined);
        }
      } catch (err) {
        setSyncError(String(err));
        // Re-sync memory with disk so the torn-flush guard's refusal window closes and the
        // retry re-fetches the failed page instead of writing past it (the store's own rule).
        await session.engine.hydrate().catch(() => undefined);
      } finally {
        setSyncing(false);
      }
    })();
    pending.current = run;
    await run;
  }, []);

  /** Go live on a session: wire the dead signal, kick the first drain. */
  const adopt = useCallback(
    (session: ConnectedSession) => {
      offDead.current?.();
      offDead.current = session.bearer.onSessionDead(() => {
        // The server judged this family's token — a revoke or a reuse-past. Render mail no
        // further: tear down and say the one-gesture remedy.
        teardown(session);
        setState({ k: "ended", reason: "this pairing ended on the server — scan a fresh QR to pair again" });
        void refreshProfiles();
      });
      setState({ k: "live", session });
      void drain(session, true);
    },
    [drain, refreshProfiles, teardown],
  );

  /**
   * The one connect body every gated transition shares: teardown, fresh keystore read BY ID,
   * boot, and — only while still the newest request — adoption. A superseded outcome closes
   * its store (the engine never started, so there is no drain to await) and changes nothing.
   */
  const runConnect = useCallback(
    async (id: string, stillCurrent: () => boolean): Promise<Attempt> => {
      if (live.current.k === "live") teardown(live.current.session);
      const row = (await env.profiles.list()).find((p) => p.id === id);
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
      pair: (origin, token) =>
        gate.run(async (stillCurrent) => {
          if (live.current.k === "live") teardown(live.current.session);
          if (stillCurrent()) setState({ k: "connecting", origin });
          const outcome = await pairWithServer(env, { origin, token });
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
          // Forgetting REVOKES server-side too (best-effort, after the local removal, never
          // blocking it): the live session's own manager holds logout; a stored profile's
          // refresh token is spent into one through `revokeProfile` — otherwise the family
          // stays live on the server until it ages out.
          const row = (await env.profiles.list()).find((p) => p.id === profileId) ?? null;
          let revokeLive: (() => Promise<void>) | null = null;
          if (live.current.k === "live" && live.current.session.profile.id === profileId) {
            const bearer = live.current.session.bearer;
            revokeLive = () => bearer.logout();
            teardown(live.current.session);
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
          await env.profiles.remove(profileId);
          await refreshProfiles();
          if (revokeLive !== null) void revokeLive().catch(() => undefined);
          else if (row !== null) void revokeProfile(env, row);
        }),
      disconnect: () =>
        gate.run(async () => {
          if (live.current.k === "live") teardown(live.current.session);
          setState({ k: "idle" });
          setSyncError(null);
        }),
      syncNow: () => {
        if (live.current.k === "live" && !syncing) void drain(live.current.session, false);
      },
    }),
    [state, syncing, syncError, profiles, activeId, adopt, drain, env, gate, refreshProfiles, runConnect, teardown],
  );

  return <ConnectionContext.Provider value={api}>{children}</ConnectionContext.Provider>;
}
