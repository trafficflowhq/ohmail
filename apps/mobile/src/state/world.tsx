/**
 * THE WORLD LAYER — one hook the mail screens render from.
 *
 * `useWorld()` answers the connected session's mirror through the shared client-engine
 * selectors (`src/state/live.ts`): reads over the consent projection, `engine.mutate`
 * behind every action, watched, with rejections surfacing as one plain toast sentence
 * ({@link useWorldToast}).
 *
 * WITHOUT A LIVE SESSION THE WORLD IS EMPTY — empty lists, no account, no-op actions.
 * The navigation gate keeps the mail screens off-screen while nothing is connected (the
 * app opens into the connect flow instead), so the empty world exists for the moments the
 * gate cannot cover: a deep link restored mid-boot, one render between a teardown and the
 * redirect. It is honestly nothing, never sample data standing in for an account.
 *
 * Computed ONCE per change here (the engine's own version signal) and shared through
 * context, rather than per screen — six consumers re-deriving five piles per render would
 * scan the mirror thirty times per drain tick.
 *
 * ── `world.actions` IS ONE OBJECT FOR THE APP'S WHOLE LIFE ────────────────────────────────
 *
 * The data half is a fresh object per change (that is what re-renders the screens); the
 * ACTIONS half is `stableActions` over a ref — constant identity, delegating to the current
 * backend per CALL. Screens hang effects off actions (`useFocusEffect` leave-commits, the
 * message screen's open), and an actions object minted per version made those effects
 * re-fire on every mirror change: the waterline committed mid-visit, and a rejected
 * mark-read re-dispatched off its own rollback's version bump.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Copy } from "../copy";
import { useConnection } from "../net/connection";
import * as Crypto from "expo-crypto";
import {
  flushQueued,
  liveActions,
  liveMessage,
  liveOhbox,
  livePiles,
  liveReads,
  liveReceipts,
  liveScreener,
  liveTags,
  presentedOf,
  readerZone,
  stableActions,
  type ScreenerRow,
  type WorldActions,
  type WorldMail,
  type WorldPile,
  type WorldTag,
  type WorldView,
} from "./live";
import type { Scope } from "./model";

export type { MoveTarget, ScreenerRow, WorldActions, WorldMail, WorldPile, WorldTag } from "./live";

export interface World {
  live: boolean;
  /**
   * WHICH SESSION this is — the live session's mirror owner key, or `"none"`. The one
   * legitimate effect dependency for "do this again when the world changes": the actions
   * facade is identity-stable BY DESIGN (so mirror versions cannot re-fire effects), which
   * means an effect that must re-run when the session goes live — the message screen's open
   * on a restored route, the sender screen's held hydration — has to depend on THIS instead.
   */
  worldKey: string;
  /** The header identity: the paired server + account id; empty while nothing is live. */
  account: { name: string; email: string };
  ohbox: {
    resurfaced: WorldMail[];
    fresh: WorldMail[];
    seen: WorldMail[];
    unread: number;
    total: number;
    meta: string;
  };
  doorbell: { initials: string[]; count: number };
  reads: {
    items: WorldMail[];
    waterlineAboveId: string | null;
    waterLabel: string;
    meta: string;
  };
  receipts: {
    groups: { label: string; items: WorldMail[] }[];
    waterlineAboveId: string | null;
    waterLabel: string;
    total: number;
    meta: string;
  };
  screener: { waiting: ScreenerRow[]; screened: ScreenerRow[]; spam: ScreenerRow[]; meta: string };
  piles: WorldPile[];
  pilesMeta: string;
  /** The account's tags, for the message screen's tag sheet — the mirror's `tag` entities. */
  tags: WorldTag[];
  message(id: string): WorldMail | undefined;
  /**
   * WHAT BECAME OF A QUEUED SEND — how a locked composer settles. `pending` while the key
   * still stands on the engine's queue; `confirmed`/`rolled_back` once a reconnect flush
   * resolved it (the ledger below); `unknown` for a key this session never queued (or after
   * a session swap — the queue is memory-only and died with its composer).
   */
  sendOutcome(key: string): "pending" | "confirmed" | "rolled_back" | "unverified" | "unknown";
  actions: WorldActions;
}

const WorldContext = createContext<World | null>(null);

export function useWorld(): World {
  const w = useContext(WorldContext);
  if (w === null) throw new Error("useWorld() outside <WorldProvider>");
  return w;
}

/** The world's toast — one sentence, no undo (the engine already rolled the act back). */
export interface WorldToast {
  toast: { id: number; message: string } | null;
  dismiss(): void;
}

const WorldToastContext = createContext<WorldToast>({ toast: null, dismiss: () => undefined });

export function useWorldToast(): WorldToast {
  return useContext(WorldToastContext);
}

/* ─────────────────────────────────────────────────────────── the empty world */

/** Every action refused politely: nothing is connected, so nothing can be done. */
const NO_ACTIONS: WorldActions = {
  markSeenThrough: () => undefined,
  leaveFeed: () => undefined,
  openMessage: () => undefined,
  hydrateMessage: () => undefined,
  hydrateHeld: () => undefined,
  decide: () => undefined,
  setScope: () => undefined,
  allow: () => undefined,
  notSpam: () => undefined,
  addToPile: () => undefined,
  pileToggle: () => undefined,
  resurfaceToggle: () => undefined,
  resurfaceAt: () => undefined,
  resurfaceNow: () => undefined,
  resurfaceDone: () => undefined,
  markSeen: () => undefined,
  move: () => undefined,
  // The empty world cannot send; the composer treats `failed` as the refusal it is.
  sendReply: () => Promise.resolve({ outcome: "failed" as const }),
  sendForward: () => Promise.resolve({ outcome: "failed" as const }),
  sendOutcome: () => "unknown",
  tagToggle: () => undefined,
  tagCreate: () => undefined,
  screenSender: () => undefined,
};

function emptyWorld(actions: WorldActions): World {
  return {
    live: false,
    worldKey: "none",
    account: { name: "", email: "" },
    ohbox: { resurfaced: [], fresh: [], seen: [], unread: 0, total: 0, meta: "" },
    doorbell: { initials: [], count: 0 },
    reads: { items: [], waterlineAboveId: null, waterLabel: Copy.waterline, meta: "" },
    receipts: { groups: [], waterlineAboveId: null, waterLabel: Copy.waterline, total: 0, meta: "" },
    screener: { waiting: [], screened: [], spam: [], meta: "" },
    piles: [],
    pilesMeta: "",
    tags: [],
    message: () => undefined,
    sendOutcome: () => "unknown",
    actions,
  };
}

/* ────────────────────────────────────────────────────────────── the provider */

export function WorldProvider({ children }: { children: ReactNode }) {
  const conn = useConnection();

  const session = conn.state.k === "live" ? conn.state.session : null;
  const engine = session?.engine ?? null;

  /* The engine's own change signal — the exact idiom `LiveFacts` (servers.tsx) established. */
  const version = useSyncExternalStore(
    useCallback((cb: () => void) => (engine ? engine.subscribe(cb) : () => undefined), [engine]),
    () => (engine ? engine.read().version() : 0),
  );

  /*
   * The toast: one sentence per rejected (or optimistically stated) act — QUEUED, not
   * replaced. A reconnect flush can settle several intents in one continuation, and React
   * batches the state updates: with a single slot, "Reply sent." followed by a rolled-back
   * move rendered only the rollback. Each sentence now takes its turn (the Toast's own
   * dismiss timer advances the queue), capped so a burst cannot backlog the screen.
   */
  const [toastQueue, setToastQueue] = useState<{ id: number; message: string }[]>([]);
  const toastSeq = useRef(0);
  const showToast = useCallback((message: string) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToastQueue((q) => (q.length >= 4 ? q : [...q, { id, message }]));
  }, []);
  const dismissToast = useCallback(() => setToastQueue((q) => q.slice(1)), []);
  const worldToast = useMemo<WorldToast>(
    () => ({ toast: toastQueue[0] ?? null, dismiss: dismissToast }),
    [toastQueue, dismissToast],
  );

  /* Per-sender scope choice (this sender / whole domain) — view state on the session,
     keyed by the STABLE routeKey (the sender address), never the representative id. */
  const [scopes, setScopes] = useState<Record<string, Scope>>({});

  /**
   * SESSION LIFECYCLE for the per-session view state. Scope choices are keyed by sender
   * ADDRESS, and the same address legitimately exists on two accounts — carried across a
   * profile switch, account A's "whole domain" would silently widen a decision on account B.
   * The outgoing session's toast is cleared for the same sessions-don't-leak reason: a
   * sentence must not resurrect when the next session renders.
   */
  const sessionKey = session?.ownerKey ?? null;
  useEffect(() => {
    setScopes({});
    setToastQueue([]);
  }, [sessionKey]);

  const zone = useMemo(readerZone, []);
  const acts = useMemo(
    // expo-crypto's v4 — the same generator the engine composition injects (`native.ts`), taken
    // from the library directly rather than through `engine/native`: the privacy suite's
    // confinement holds that no state module imports the engine composition (the connection
    // layer is the one door), and a uuid is randomness, not network. See `LiveDeps.uuid` for
    // why a created tag's row id needs the real thing.
    () => (engine ? liveActions({ engine, toast: showToast, uuid: () => Crypto.randomUUID(), zone }) : null),
    [engine, showToast, zone],
  );

  /*
   * ── THE RECONNECT FLUSH ─────────────────────────────────────────────────────────────────
   *
   * A retryable rejection parks its mutation on the engine's queue under its
   * Idempotency-Key, and `flushPending` had NO caller in this app — a queued intent (a send,
   * a triage press taken offline) stood forever while its toast said "still trying". The
   * proof the server is reachable again is a drain completing (`conn.syncing` falling with
   * no error), so the queue flushes HERE, with the same keys — which is what makes the retry
   * unable to double-deliver. It lives in the world layer, not the connection, because the
   * two things a terminal outcome owes are both here: the TOAST (an intent that will never
   * send must say so out loud) and the LEDGER a locked composer settles from.
   */
  const outcomes = useRef(new Map<string, "confirmed" | "rolled_back" | "unverified">());
  const [outcomeSeq, setOutcomeSeq] = useState(0);
  /** The engine mid-flush (held by identity alone — the engine type stays behind the seam,
   *  which is why this is `object`), or null. SESSION-SCOPED: profile A's in-flight flush
   *  must neither block B's first one nor write A's outcomes into B's ledger after the switch. */
  const flushing = useRef<object | null>(null);
  /** The engine the ledger reads — a ref, so `outcomeOf` has one identity. */
  const backendEngineRef = useRef(engine);
  backendEngineRef.current = engine;
  const outcomeOf = useCallback(
    (key: string): "pending" | "confirmed" | "rolled_back" | "unverified" | "unknown" => {
      const settled = outcomes.current.get(key);
      if (settled) return settled;
      const eng = backendEngineRef.current;
      return eng && eng.pendingMutations().some((m) => m.key === key) ? "pending" : "unknown";
    },
    [],
  );
  /** Keys already retried since the last drain — a requeued batch is NOT immediately retried
   *  again (a persistent 500 or a ten-minute `send_in_flight` would loop hot); the next
   *  drain's start clears the latch, because a fresh drain is the next connectivity proof. */
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (conn.syncing) tried.current.clear();
  }, [conn.syncing]);
  useEffect(() => {
    if (conn.syncing || engine === null || flushing.current === engine) return;
    const pending = engine.pendingMutations();
    if (pending.length === 0) return;
    // Everything pending was already retried since the last drain: wait for the next one.
    // (A NEW intent arriving beside a stuck key does flush the whole queue — the engine's
    // flush has no key filter — so a stuck key is replayed at most once per genuinely new
    // arrival, under its unchanged Idempotency-Key. Bounded by user acts, never a loop; a
    // keyed flush is an engine seam change and deliberately not made from this app.)
    if (pending.every((m) => tried.current.has(m.key))) return;
    for (const m of pending) tried.current.add(m.key);
    const flushed = engine;
    flushing.current = flushed;
    void flushQueued(flushed)
      .then((settled) => {
        // A flush that outlived its session says nothing: the ledger and the toasts belong
        // to the session on screen, and this one's is gone.
        if (backendEngineRef.current !== flushed) return;
        for (const [key, o] of settled) {
          outcomes.current.set(key, o.status);
          // The one visible sentence per terminal outcome — a background send confirming
          // announces itself (the queued toast promised it would keep trying), an
          // unverified one says check-Sent, and any other rollback says it plainly.
          if (o.kind === "mail_send") {
            if (o.status === "confirmed") showToast(o.forward ? Copy.forwarded : Copy.replySent);
            else if (o.status === "unverified") showToast(Copy.replyUnverified);
            else showToast(Copy.replyFailed);
          } else if (o.status === "rolled_back") {
            showToast(Copy.liveSaveFailed);
          }
        }
        if (settled.size > 0) setOutcomeSeq((n) => n + 1);
      })
      .finally(() => {
        if (flushing.current === flushed) flushing.current = null;
        // Re-run the effect: intents queued DURING this flush (or on a session that switched
        // in under it) get their turn — the tried-latch keeps the batch that was merely
        // REQUEUED from spinning a retry loop against a server that keeps refusing.
        setOutcomeSeq((n) => n + 1);
      });
    // `conn.syncing` falling is the drain-completed signal; `outcomeSeq` re-checks after a flush.
  }, [conn.syncing, engine, showToast, outcomeSeq]);
  // The outgoing session's ledger must not answer for the next session's keys.
  useEffect(() => {
    outcomes.current = new Map();
  }, [sessionKey]);

  /* The CURRENT backend, refreshed per render; the stable facade delegates per call. */
  const backendRef = useRef<WorldActions>(NO_ACTIONS);
  backendRef.current =
    engine && acts
      ? {
          markSeenThrough: (place, ids) => void acts.sweepFeed(place, ids),
          leaveFeed: (place) => void acts.leaveFeed(place),
          openMessage: (id) => void acts.openMessage(id),
          hydrateMessage: (id) => acts.hydrateMessage(id),
          hydrateHeld: (ids) => acts.hydrateHeld(ids),
          decide: (row, dest, read) => void acts.decide(row, dest, read, row.scope),
          setScope: (row, scope) => setScopes((held) => ({ ...held, [row.routeKey]: scope })),
          allow: (row, dest) => void acts.release(row, dest, "screened"),
          notSpam: (row, dest) => void acts.release(row, dest, "spam"),
          addToPile: (kind, item) => {
            if (item.messageId) void acts.setPile(item.messageId, kind);
          },
          pileToggle: (id, kind) => void acts.pileToggle(id, kind),
          resurfaceToggle: (id) => void acts.resurfaceToggle(id),
          resurfaceAt: (id, iso) => void acts.resurfaceAt(id, iso),
          resurfaceNow: (id) => void acts.resurfaceNow(id),
          resurfaceDone: (id) => void acts.resurfaceDone(id),
          markSeen: (id, unread) => void acts.markSeen(id, unread),
          move: (id, dest) => void acts.move(id, dest),
          sendReply: (id, body, all) => acts.sendReply(id, body, all),
          sendForward: (id, to, body) => acts.sendForward(id, to, body),
          sendOutcome: (key) => outcomeOf(key),
          tagToggle: (id, tag, assigned) => void acts.tagToggle(id, tag, assigned),
          tagCreate: (id, name) => void acts.tagCreate(id, name),
          screenSender: (id, dest, scope) => void acts.screenSender(id, dest, scope),
        }
      : NO_ACTIONS;
  /* One identity for the app's life — see the header for what per-version identity cost. */
  const actions = useMemo(() => stableActions(() => backendRef.current), []);

  const world = useMemo<World>(() => {
    if (engine === null || session === null) return emptyWorld(actions);
    const v: WorldView = { now: new Date(), zone };
    const pres = presentedOf(engine.read(), v.now);
    const ohbox = liveOhbox(pres, v);
    const reads = liveReads(pres, v);
    const receipts = liveReceipts(pres, v);
    const screener = liveScreener(pres, v, scopes);
    const piles = livePiles(pres, v);
    const pileTotal = piles.reduce((n, p) => n + p.items.length, 0);
    return {
      live: true,
      worldKey: session.ownerKey,
      account: { name: session.profile.origin, email: session.profile.accountId },
      ohbox: { ...ohbox, meta: `${ohbox.unread} unread of ${ohbox.total}` },
      doorbell: {
        initials: screener.waiting.map((r) => r.initial),
        count: screener.waiting.length,
      },
      reads: {
        ...reads,
        waterLabel: Copy.waterline,
        meta: `${reads.newCount} new`,
      },
      receipts: {
        groups: receipts.groups,
        waterlineAboveId: receipts.waterlineAboveId,
        waterLabel: Copy.waterline,
        total: receipts.total,
        meta: `${receipts.newCount} new`,
      },
      screener: {
        ...screener,
        meta: `${screener.waiting.length} first-time sender${screener.waiting.length === 1 ? "" : "s"} waiting`,
      },
      piles,
      pilesMeta: `${pileTotal} item${pileTotal === 1 ? "" : "s"}`,
      // The RAW mirror, like the webapp's `reader.list<TagDTO>("tag")` — tags are not projected.
      tags: liveTags(engine.read()),
      message: (id) => liveMessage(engine, id, { now: new Date(), zone }),
      sendOutcome: outcomeOf,
      actions,
    };
    // `version` IS the dependency that re-derives the world on every mirror change; the
    // reader itself is stable across drains, so it cannot stand in for it — and `outcomeSeq`
    // re-derives it when a reconnect flush settles a queued key, so a locked composer's
    // settle effect fires without a mirror change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, session, scopes, zone, actions, version, outcomeSeq, outcomeOf]);

  return (
    <WorldContext.Provider value={world}>
      <WorldToastContext.Provider value={worldToast}>{children}</WorldToastContext.Provider>
    </WorldContext.Provider>
  );
}
