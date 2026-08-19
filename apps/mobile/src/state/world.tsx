/**
 * THE WORLD LAYER — one hook the mail screens render from, whichever world is on.
 *
 * `useWorld()` answers the SAME shape in both modes, so a screen holds no branch beyond the
 * few live-only affordances it hides (the demo's AI chrome, the fixtures disclaimer):
 *
 *  · **demo** — the fixtures machine, verbatim: every list comes from `derived.ts`'s own
 *    selectors and every action delegates to the store's pure transitions, so the demo world
 *    renders and behaves exactly as before this layer existed (fixtures mode
 *    stays whole; the no-collapse manifest still holds over these selectors).
 *  · **live** — `src/state/live.ts`: the shared client-engine selectors over the consent
 *    projection, and `engine.mutate` behind every action, watched, with rejections surfacing
 *    as one plain toast sentence ({@link useWorldToast}).
 *
 * Computed ONCE per change here (the engine's own version signal / the store's state) and
 * shared through context, rather than per screen — six consumers re-deriving five piles per
 * render would scan the mirror thirty times per drain tick.
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
import type { TagId } from "@ohmail/fixtures";
import { Copy } from "../copy";
import { useConnection } from "../net/connection";
import * as D from "./derived";
import {
  attachmentLabelOf,
  liveActions,
  liveMessage,
  liveOhbox,
  livePiles,
  liveReads,
  liveReceipts,
  liveScreener,
  presentedOf,
  readerZone,
  sourceOf,
  stableActions,
  type ScreenerRow,
  type WorldActions,
  type WorldMail,
  type WorldPile,
  type WorldView,
} from "./live";
import { world as fixtures, type AppState, type Scope } from "./model";
import { useStore, type Store } from "./store";

export type { ScreenerRow, WorldActions, WorldMail, WorldPile } from "./live";

export interface World {
  live: boolean;
  /**
   * WHICH WORLD/SESSION this is — `"demo"`, or the live session's mirror owner key. The one
   * legitimate effect dependency for "do this again when the world changes": the actions
   * facade is identity-stable BY DESIGN (so mirror versions cannot re-fire effects), which
   * means an effect that must re-run when demo becomes live — the message screen's open on
   * a restored route, the sender screen's held hydration — has to depend on THIS instead.
   */
  worldKey: string;
  /** The header identity: Mila's fixture account, or the paired server + account id. */
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
    waterMeta: string;
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
  message(id: string): WorldMail | undefined;
  tagsOf(id: string): TagId[];
  actions: WorldActions;
}

const WorldContext = createContext<World | null>(null);

export function useWorld(): World {
  const w = useContext(WorldContext);
  if (w === null) throw new Error("useWorld() outside <WorldProvider>");
  return w;
}

/** The live world's toast — one sentence, no undo. Rendered by the chrome beside the demo's. */
export interface WorldToast {
  toast: { id: number; message: string } | null;
  dismiss(): void;
}

const WorldToastContext = createContext<WorldToast>({ toast: null, dismiss: () => undefined });

export function useWorldToast(): WorldToast {
  return useContext(WorldToastContext);
}

/* ────────────────────────────────────────────────────────────── demo arm */

function demoScreenerRows(s: AppState): { waiting: ScreenerRow[]; screened: ScreenerRow[]; spam: ScreenerRow[] } {
  return {
    waiting: s.waiting.map((w) => ({
      id: w.id,
      // The demo's own ids are stable (the fixtures machine keys senders by them), so the
      // route key IS the id there — live rows key by the sender address instead.
      routeKey: w.id,
      name: w.from.name,
      address: w.from.address,
      initial: w.initial,
      time: w.time,
      newestSubject: w.held[w.held.length - 1]?.subject ?? "",
      dull: w.dull,
      scope: w.scope,
      ai: w.ai,
      held: w.held,
      screenedOn: "",
      detection: "",
      gatePhysical: true,
    })),
    screened: s.screened.map((x) => ({
      id: x.id,
      routeKey: x.id,
      name: x.address,
      address: x.address,
      initial: (x.address.trim()[0] ?? "?").toUpperCase(),
      time: "",
      newestSubject: x.held[x.held.length - 1]?.subject ?? "",
      dull: false,
      scope: "sender" as const,
      ai: null,
      held: x.held,
      screenedOn: x.screenedOn,
      detection: "",
      gatePhysical: true,
    })),
    spam: s.spam.map((x) => ({
      id: x.id,
      routeKey: x.id,
      name: x.from,
      address: x.from,
      initial: (x.from.trim()[0] ?? "?").toUpperCase(),
      time: "",
      newestSubject: x.held[x.held.length - 1]?.subject ?? "",
      dull: false,
      scope: "sender" as const,
      ai: null,
      held: x.held,
      screenedOn: "",
      detection: x.detection,
      gatePhysical: true,
    })),
  };
}

/** A demo message, with the attachment strip resolved through the shared name fallback. */
function demoMessage(s: AppState, id: string): WorldMail | undefined {
  const m = D.mail(s, id);
  if (!m) return undefined;
  const label = attachmentLabelOf(m);
  return {
    ...m,
    ...(m.attachment && label
      ? { attachments: [{ id: m.id, filename: label, size: m.attachment.size }] }
      : {}),
  };
}

/** The demo backend: every act is the store's own pure transition, verbatim. */
function demoBackend(store: Store): WorldActions {
  return {
    markSeenThrough: (place, ids) => store.markSeenThrough(place, ids),
    leaveFeed: () => undefined,
    openMessage: () => undefined,
    hydrateMessage: () => undefined,
    hydrateHeld: () => undefined,
    decide: (row, dest, read) => store.decide(row.id, dest, read),
    setScope: (row, scope) => store.setScope(row.id, scope),
    allow: (row, dest) => store.allowScreened(row.id, dest),
    notSpam: (row, dest) => store.notSpam(row.id, dest),
    applyAllSuggestions: () => store.applyAllSuggestions(),
    addToPile: (kind, item) => store.addToPile(kind, item),
    toggleTag: (messageId, tag) => store.toggleTag(messageId, tag),
  };
}

function demoWorld(store: Store, actions: WorldActions): World {
  const s = store.s;
  const rows = demoScreenerRows(s);
  return {
    live: false,
    worldKey: "demo",
    account: { name: fixtures.account.displayName, email: fixtures.account.email },
    ohbox: {
      resurfaced: [],
      fresh: D.ohboxNew(s),
      seen: D.ohboxSeen(s),
      unread: D.ohboxUnread(s),
      total: s.ohbox.length,
      meta: D.ohboxMeta(s),
    },
    doorbell: { initials: s.waiting.map((w) => w.initial), count: s.waiting.length },
    reads: {
      items: D.readsStream(s),
      waterlineAboveId: D.waterlineAbove(s),
      waterLabel: fixtures.waterline.label,
      waterMeta: fixtures.waterline.meta,
      meta: D.readsMeta(s),
    },
    receipts: {
      groups: D.receiptGroups(s),
      waterlineAboveId: null,
      waterLabel: Copy.waterline,
      total: D.receiptStream(s).length,
      meta: D.receiptsMeta(s),
    },
    screener: { ...rows, meta: D.screenerMeta(s) },
    piles: s.piles.map((p) => ({ kind: p.kind, title: p.title, note: p.note, items: p.items })),
    pilesMeta: D.triageMeta(s),
    message: (id) => demoMessage(s, id),
    tagsOf: (id) => D.tagsOfMessage(s, id),
    actions,
  };
}

/* ────────────────────────────────────────────────────────────── the provider */

export function WorldProvider({ children }: { children: ReactNode }) {
  const conn = useConnection();
  const store = useStore();

  const source = sourceOf(conn.state);
  const session = source.mode === "live" ? source.session : null;
  const engine = session?.engine ?? null;

  /* The engine's own change signal — the exact idiom `LiveFacts` (servers.tsx) established. */
  const version = useSyncExternalStore(
    useCallback((cb: () => void) => (engine ? engine.subscribe(cb) : () => undefined), [engine]),
    () => (engine ? engine.read().version() : 0),
  );

  /* The live toast: one sentence per rejected (or optimistically stated) act. */
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((message: string) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, message });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);
  const worldToast = useMemo<WorldToast>(() => ({ toast, dismiss: dismissToast }), [toast, dismissToast]);

  /* Per-sender scope choice (this sender / whole domain) — view state on a live account,
     keyed by the STABLE routeKey (the sender address), never the representative id. */
  const [scopes, setScopes] = useState<Record<string, Scope>>({});

  /**
   * SESSION LIFECYCLE for the per-session view state. Scope choices are keyed by sender
   * ADDRESS, and the same address legitimately exists on two accounts — carried across a
   * profile switch, account A's "whole domain" would silently widen a decision on account B.
   * The outgoing world's toast is cleared for the same
   * worlds-don't-leak reason: a sentence hidden by the world gate must not resurrect when
   * that world next renders. The demo store's own toast is dismissed through a ref so this
   * effect keys on the SESSION alone, not on every store update.
   */
  const dismissDemoToast = useRef(store.dismissToast);
  dismissDemoToast.current = store.dismissToast;
  const sessionKey = session?.ownerKey ?? null;
  useEffect(() => {
    setScopes({});
    setToast(null);
    dismissDemoToast.current();
  }, [sessionKey]);

  const zone = useMemo(readerZone, []);
  const acts = useMemo(
    () => (engine ? liveActions({ engine, toast: showToast }) : null),
    [engine, showToast],
  );

  /* The CURRENT backend, refreshed per render; the stable facade delegates per call. */
  const backendRef = useRef<WorldActions | null>(null);
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
          applyAllSuggestions: () => undefined,
          addToPile: (kind, item) => {
            if (item.messageId) void acts.setPile(item.messageId, kind);
          },
          toggleTag: () => undefined,
        }
      : demoBackend(store);
  /* One identity for the app's life — see the header for what per-version identity cost. */
  const actions = useMemo(() => stableActions(() => backendRef.current ?? demoBackend(store)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const world = useMemo<World>(() => {
    if (engine === null || session === null) return demoWorld(store, actions);
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
        waterMeta: "",
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
      message: (id) => liveMessage(engine, id, { now: new Date(), zone }),
      tagsOf: () => [],
      actions,
    };
    // `version` IS the dependency that re-derives the live world on every mirror change; the
    // reader itself is stable across drains, so it cannot stand in for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, session, store, scopes, zone, actions, version]);

  return (
    <WorldContext.Provider value={world}>
      <WorldToastContext.Provider value={worldToast}>{children}</WorldToastContext.Provider>
    </WorldContext.Provider>
  );
}
