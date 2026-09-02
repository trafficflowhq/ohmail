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
import {
  readFoldersEnabled,
  writeFoldersEnabled,
  writeThemeFace,
  type FoldersConsent,
} from "../net/consent";
import { readMailboxes, type PhoneMailbox } from "../net/mailboxes";
import { readFolderSummary } from "../net/folder-ops";
import * as Crypto from "expo-crypto";
import type { FaceName } from "../theme/face";
import { faceScope } from "./face-scope";
import { foldersFlag, freshestRead } from "./folders-flag";
import { usePrefs } from "./store";
import {
  flushQueued,
  liveActions,
  liveFolder,
  liveFolders,
  liveFolderUnread,
  liveMessage,
  liveOhbox,
  livePiles,
  liveReads,
  liveReceipts,
  liveScheduled,
  liveScreener,
  liveTags,
  mirrorSettled,
  phoneOrganizer,
  presentedOf,
  scheduleLabel,
  staleAsOf,
  readerZone,
  soleMessageMailbox,
  stableActions,
  type FolderEntity,
  type ScreenerRow,
  type WorldActions,
  type PhoneOrganizer,
  type WorldMail,
  type WorldPile,
  type WorldScheduled,
  type WorldTag,
  type WorldView,
} from "./live";
import type { Scope } from "./model";

export type {
  FolderEntity, MoveTarget, PhoneOrganizer, ScreenerRow, WorldActions, WorldMail, WorldPile,
  WorldScheduled, WorldTag,
} from "./live";

export interface World {
  live: boolean;
  /**
   * THE BOOT FACTS every list screen renders its surface from (`state/surface.ts`):
   * `settled` — this mirror has EVER completed a drain (`live.ts#mirrorSettled`), so its
   * zero-row lists are genuinely empty rather than unknown; `syncFailure` — the connection's
   * standing failure sentence, for the one stall a first-ever launch can hit (a dead network
   * under an unsettled mirror, where the skeleton alone would pulse without explanation).
   * On the empty world `settled` is false: the render between a teardown and the redirect
   * shows the honest unknown, never a fictitious emptiness.
   */
  boot: {
    settled: boolean;
    syncFailure: string | null;
    /**
     * The stale label's sentence-ready time ("Fri 09:00", the reader's zone), or null when the
     * mirror is current or has never settled — `live.ts#staleAsOf`, the Freshness Contract's
     * middle state. Non-null means the chrome owes "As of <time> · catching up" until a drain
     * settles; the derivation clears it in the same world re-derive that applies the drain.
     */
    staleAsOf: string | null;
  };
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
  /**
   * THE MAILBOX FACTS — `GET /mailboxes` over the paired server (`src/net/mailboxes.ts`), on the
   * folders flag's own cadence (boot + after every completed drain).
   *
   * This client had NO mailbox read at all until now, and two surfaces said so in their own
   * comments (`live.ts`): the reader could not be told apart from the other recipients, and the
   * onboarding deck's `phoneBanner` had no consumer because naming a holder with no source
   * would be an invented claim.
   *
   * `known` is what separates "the account has no mailboxes" from "nobody has asked yet", and
   * it is the gate the banner is drawn behind — a phone that has not read yet must say nothing
   * about who organizes anything. It goes true on the first SUCCESSFUL read and stays true for
   * the session; a later failure keeps the last known answer rather than blanking a banner on a
   * flaky request (`readMailboxes` returns `null` for "could not ask", never an empty list).
   */
  mailboxes: {
    known: boolean;
    /** Every mailbox address on the account — the reader's own, for `canReplyAll` and reply-all. */
    ownAddresses: readonly string[];
    /** Who organizes them, when one holder organizes all of them and is named. */
    organizer: PhoneOrganizer | null;
  };
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
    /**
     * THE STREAM'S BADGE — `FeedPartition.newCount` carried through unchanged, so the dock and
     * the screen's meta line read ONE number and the browser's rail reads the same field. It is
     * published here because the dock used to compute its own (`items.filter(unread)`), which
     * counted mail below the line as well and, once a pinned row is drawn unread, counted pins.
     */
    newCount: number;
    meta: string;
  };
  receipts: {
    groups: { label: string; items: WorldMail[] }[];
    waterlineAboveId: string | null;
    waterLabel: string;
    total: number;
    /** The stream's badge — see {@link WorldState.reads.newCount}. */
    newCount: number;
    meta: string;
  };
  screener: { waiting: ScreenerRow[]; screened: ScreenerRow[]; spam: ScreenerRow[]; meta: string };
  piles: WorldPile[];
  pilesMeta: string;
  /** The account's tags, for the message screen's tag sheet — the mirror's `tag` entities. */
  tags: WorldTag[];
  /**
   * THE SCHEDULED SENDS (Send later, mail 0077) — every draft wearing an appointment, soonest
   * first, already read in the reader's clock (`live.ts#liveScheduled`). Ungated: an
   * appointment is the account's own state and the phone mirrors `draft` entities on every
   * drain, so a message scheduled from the web is visible — and cancellable — here.
   */
  scheduled: WorldScheduled[];
  /**
   * THE FOLDERS SURFACE (FOLDERS-SPEC.md; stage-1 read-only parity with the webapp's
   * foundation). `enabled` is the SERVER's consent answer (`GET /consent`,
   * `foldersEnabledAt != null`), fetched once per session and re-written only by a confirmed
   * `setEnabled` — never an optimistic pick, the webapp `FoldersRow`'s own rule. With the flag
   * off, `list` is empty whatever `folder` entities a stale mirror still holds (the flag is
   * the authority, the entities are data), so the off state is the pre-feature interface.
   */
  folders: {
    enabled: boolean;
    list: FolderEntity[];
    /** Per-folder unread over the projection, keyed `mailboxId|name`. */
    unread: ReadonlyMap<string, number>;
    byId(id: string): FolderEntity | undefined;
    /** One folder's mail as the folder screen renders it — unread first, newest first. */
    items(id: string): { fresh: WorldMail[]; seen: WorldMail[]; unread: number; total: number };
    /** A toggle write is in flight — the Settings control disables rather than double-writing. */
    pending: boolean;
    /** Resolves `true` when the server confirmed the write; `false` is the failure sentence's cue. */
    setEnabled(on: boolean): Promise<boolean>;
    /**
     * The delete confirm's SERVER-truth numbers (`GET /folders/:id/summary`) — the mirror is
     * windowed, so only the server can say "N messages across M folders". `null` is "could
     * not count": the confirm still asks, with the uncounted sentence (the webapp's degrade).
     */
    summary(folderId: string): Promise<{ folders: number; messages: number } | null>;
    /**
     * The one mailbox a FIRST create can name when zero folder entities exist to derive a
     * section from (`live.ts#soleMessageMailbox`) — `null` when the mirror names none or
     * several, or when folders already exist (the sections carry the affordance then).
     */
    soleCreateMailboxId: string | null;
  };
  /**
   * THE ACCOUNT'S STORED SIGNATURES — `{ mailboxId: text }`, from the consent read (`GET
   * /consent`, mail 0075), riding the folders flag's own cadence (boot + after every drain,
   * so a signature saved in the webapp's Settings reaches an open phone). `null` until a read
   * SUCCEEDS for this session — the webapp's `signaturesKnown` gate: the composer's block
   * renders from a server-confirmed answer or not at all, never from a guess.
   */
  signatures: Readonly<Record<string, string>> | null;
  /**
   * THE APPEARANCE FACE'S ACCOUNT SCOPE (OHMARCHY-PLAN.md §3a). The DEVICE scope is not here —
   * it is `usePrefs().facePin`, which needs no session and works with the radio off; this half
   * is the account's synced answer and the one press that writes it.
   *
   * `account` rides the folders flag's own `GET /consent` cadence (boot + after every drain), so
   * a face chosen in the webapp's Settings reaches an open phone without a new mechanism. `null`
   * means the account has no preference, and the empty world has none either — a face is an
   * account's state, and there is no account until something is connected.
   */
  face: {
    account: FaceName | null;
    /**
     * HAS THE ACCOUNT'S FACE BEEN READ AT ALL this session? (review-caught, and the whole reason
     * `account` alone is not enough.) `account: null` means two different things until this is
     * true — "the account has no preference" and "nobody has asked yet" — and the account-wide
     * WRITE must not fire on the second: with no device pin the control shows paper, and pressing
     * "apply on all devices" would PATCH paper over an ohmarchy the account really holds while its
     * read was slow or failing. The webapp carries the same fact as `themeFaceKnown` and
     * `AppShell` gates the affordance on it.
     *
     * True once an answer has been ADOPTED — a successful read, or a write's own echo. A read the
     * coordinator refused (one that overlapped a write) does not count, which is the conservative
     * direction: the thing being gated is precisely the act that must not run on a value nobody
     * trusts.
     */
    known: boolean;
    /** An account write is on the wire — the control disables rather than double-writing. */
    pending: boolean;
    /**
     * "Apply on all devices": PATCH the account, adopt the ECHO, drop this device's pin.
     * Resolves `true` only when the account confirmed it; `false` is the failure sentence's cue
     * and leaves both the adopted face and the pin exactly as they were.
     */
    applyAll(face: FaceName): Promise<boolean>;
  };
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
  deleteMessage: () => undefined,
  // The empty world cannot send; the composer treats `failed` as the refusal it is.
  sendReply: () => Promise.resolve({ outcome: "failed" as const }),
  sendForward: () => Promise.resolve({ outcome: "failed" as const }),
  // Nor cancel: `false` is "not confirmed", which is exactly what nothing-connected means.
  cancelSchedule: () => Promise.resolve(false),
  sendOutcome: () => "unknown",
  tagToggle: () => undefined,
  tagCreate: () => undefined,
  screenSender: () => undefined,
  folderCreate: () => undefined,
  folderRename: () => undefined,
  folderDelete: () => undefined,
  folderDismiss: () => undefined,
};

function emptyWorld(actions: WorldActions): World {
  return {
    live: false,
    boot: { settled: false, syncFailure: null, staleAsOf: null },
    worldKey: "none",
    account: { name: "", email: "" },
    // Nothing has been asked on the empty world, so `known` is false and the banner is withheld
    // — the same honest-unknown the boot facts keep between a teardown and the redirect.
    mailboxes: { known: false, ownAddresses: [], organizer: null },
    ohbox: { resurfaced: [], fresh: [], seen: [], unread: 0, total: 0, meta: "" },
    doorbell: { initials: [], count: 0 },
    reads: { items: [], waterlineAboveId: null, waterLabel: Copy.waterline, newCount: 0, meta: "" },
    receipts: { groups: [], waterlineAboveId: null, waterLabel: Copy.waterline, total: 0, newCount: 0, meta: "" },
    screener: { waiting: [], screened: [], spam: [], meta: "" },
    piles: [],
    pilesMeta: "",
    tags: [],
    scheduled: [],
    folders: {
      enabled: false,
      list: [],
      unread: new Map(),
      byId: () => undefined,
      items: () => ({ fresh: [], seen: [], unread: 0, total: 0 }),
      pending: false,
      setEnabled: () => Promise.resolve(false),
      // Could-not-count, honestly: nothing is connected, so nothing can be counted.
      summary: () => Promise.resolve(null),
      soleCreateMailboxId: null,
    },
    signatures: null,
    // No account, so no account face, nothing that could have been read, and nothing to write one
    // to. `false` is "not confirmed", which is exactly what nothing-connected means.
    face: { account: null, known: false, pending: false, applyAll: () => Promise.resolve(false) },
    message: () => undefined,
    sendOutcome: () => "unknown",
    actions,
  };
}

/* ────────────────────────────────────────────────────────────── the provider */

export function WorldProvider({ children }: { children: ReactNode }) {
  const conn = useConnection();
  /* The DEVICE half of the face lives in the prefs store (above this provider), and the account
     half is here. This layer only ever CLEARS the pin, and only after a confirmed account write —
     which is what "apply on all devices" asked for. It never sets one. */
  const { facePin, setFacePin } = usePrefs();

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

  /*
   * ── "USE FOLDERS" — the consent answer, per session ──────────────────────────────────────
   *
   * OFF until the SERVER says otherwise: the pre-feature interface is the safe branch in both
   * directions (FOLDERS-SPEC.md §10), so a session that cannot be asked renders no folders.
   * Read once per session through the consent seam; a stale answer from a superseded session
   * is discarded (the cleanup's flag), and a switch write lands only on the session it was
   * asked on — account A's folders must never draw account B's rail.
   */
  const [foldersOn, setFoldersOn] = useState(false);
  const [foldersPending, setFoldersPending] = useState(false);
  /**
   * The account's stored signatures, or `null` until a consent read SUCCEEDS this session
   * (`signaturesKnown`, structurally — see {@link World.signatures}). They ride the SAME
   * `GET /consent` the folders flag reads, on the machine's own cadence; the phone never
   * WRITES a signature, so there is no user-wins epoch to keep — `freshestRead` (built per
   * machine below) guards the one race that exists: two overlapping reads settling out of
   * issue order.
   */
  const [signatures, setSignatures] = useState<Readonly<Record<string, string>> | null>(null);
  /**
   * THE ACCOUNT'S MAILBOXES, or `null` until a read SUCCEEDS this session (which is what
   * {@link World.mailboxes.known} publishes). Nothing on this phone ever writes a mailbox, so
   * freshest-successful-read-wins is the whole rule — the signatures' exact situation, and it
   * uses the same `freshestRead` wrapper for the same race: two overlapping reads settling out
   * of issue order, the boot GET still in the air when a drain-completed refresh fires.
   *
   * A session swap resets it to `null` below, beside the signatures and the face: account A's
   * mailbox addresses must never make account B's reader recognisable, which is the same rule
   * one field up and the reason this is state rather than a ref.
   */
  const [mailboxes, setMailboxes] = useState<readonly PhoneMailbox[] | null>(null);
  /**
   * THE ACCOUNT'S FACE, and a write in flight. `null` is "the account has no preference", which
   * is also where a fresh session starts — account A's face must never skin account B, the same
   * rule the signatures keep one field up.
   */
  const [accountFace, setAccountFace] = useState<FaceName | null>(null);
  /** See {@link World.face.known} — `accountFace: null` is ambiguous until this is true. */
  const [accountFaceKnown, setAccountFaceKnown] = useState(false);
  const [facePending, setFacePending] = useState(false);
  /**
   * THE PIN AS IT STANDS RIGHT NOW, readable at write-completion time (review-caught). The
   * selector is live while the PATCH flies, so the pin may have moved since the press; a closure
   * over the render's value would release a choice this write knows nothing about.
   */
  const pinNow = useRef(facePin);
  pinNow.current = facePin;
  /**
   * THE READER'S OWN ADDRESSES AS THEY STAND RIGHT NOW, readable at send time — the same shape
   * and the same reason as `pinNow` above. The actions facade is identity-stable by design and
   * the mailbox read lands after it is built, so a value closed over at construction would send
   * every reply-all of the session against an empty set.
   */
  const addressesNow = useRef<readonly string[]>([]);
  addressesNow.current = useMemo(
    () => (mailboxes ?? []).map((b) => b.address),
    [mailboxes],
  );
  /** `conn.syncNow` behind a ref so the machine below keeps one identity across renders. */
  const syncNowRef = useRef(conn.syncNow);
  syncNowRef.current = conn.syncNow;
  /** `conn.syncing` behind a ref, read at drain time — the machine's deps keep one identity. */
  const syncingRef = useRef(conn.syncing);
  syncingRef.current = conn.syncing;
  /**
   * A DRAIN THE MACHINE ASKED FOR WHILE ONE WAS RUNNING — owed, not dropped. `syncNow` is
   * deliberately a no-op mid-drain (`connection.tsx`), and the toggle's PATCH routinely
   * resolves while the session's own drain is in the air; that drain may have crossed the
   * server's cutline BEFORE the flip's folder rows were written, so firing-and-forgetting
   * here left a confirmed switch over a mirror with no folder entities until the next wake.
   * The syncing-falling effect below pays the debt.
   */
  const drainOwed = useRef(false);
  /**
   * ONE {@link foldersFlag} MACHINE PER SESSION — closes over `session` at construction, so a
   * machine from a superseded session cannot write (`writeFoldersEnabled`/`readFoldersEnabled`
   * take the session they were built with, not a ref that could have moved on). Rebuilt only
   * when the session identity changes; `useMemo` rather than a ref because the machine's own
   * epoch must reset to "no write yet" for a fresh session, exactly like `foldersOn` below.
   *
   * `apply` is gated on IDENTITY, not merely on the machine's own epoch: a session swap builds
   * a NEW machine and this effect resets `foldersOn` to false, but the OLD machine's in-flight
   * read or write can still resolve afterwards — its own epoch says nothing about a session it
   * has no idea replaced it. `current` always names the live machine, so a stale settle applies
   * nothing to a session it does not belong to (the same discipline the outcome ledger and the
   * reconnect flush already carry for exactly this shape).
   */
  const current = useRef<ReturnType<typeof foldersFlag> | null>(null);
  /**
   * ONE {@link faceScope} PER SESSION, beside the folders machine and built with it — it closes
   * over the same `session`, so a superseded machine cannot write to a server the app has left,
   * and its epoch resets to "no write yet" for a fresh session exactly like `accountFace` does.
   *
   * It rides the folders machine's `GET /consent` rather than issuing one of its own: the read
   * already happens at boot and after every drain, and a second request for a field the first
   * one carries would be a new mechanism for nothing. What the face needs on top is the ISSUE
   * stamp, which is why `beginRead()` is taken before the fetch and its applier called after —
   * see `face-scope.ts` for the race that shape exists for.
   */
  const faceCurrent = useRef<ReturnType<typeof faceScope> | null>(null);
  const machine = useMemo(() => {
    if (!session) {
      faceCurrent.current = null;
      return (current.current = null);
    }
    const faces = faceScope({
      write: (face) => writeThemeFace(session, face),
      adopt: (face) => {
        if (faceCurrent.current !== faces) return;
        setAccountFace(face);
        // Adopting IS knowing: this value came from a successful read or a write's echo.
        setAccountFaceKnown(true);
      },
      /* The pin is released only on a confirmed write, only while this session still owns the
         machine (a late settle from a session the user has left must not touch the face of the
         one on screen), and only when it is still the pin the press was made under — a newer
         choice made while the PATCH flew is a decision this write knows nothing about. A pin of
         `null` is released too, which is a no-op and keeps the webapp `FaceRow`'s exact rule. */
      clearPin: (submitted) => {
        if (faceCurrent.current !== faces) return;
        if (pinNow.current === submitted || pinNow.current === null) setFacePin(null);
      },
    });
    faceCurrent.current = faces;
    // The signatures ride the flag's read but keep their OWN ordering: the machine's epoch
    // protects the flag against a user's write; nothing writes signatures from this phone, so
    // freshest-successful-read-wins is the whole rule (`freshestRead`). Identity-gated like
    // `apply` — a superseded session's late answer applies nothing.
    const sigRead = freshestRead<FoldersConsent>((ans) => {
      if (current.current === m) setSignatures(ans.signatures);
    });
    /* THE MAILBOX READ, built beside the folders machine and gated on the SAME identity: a
       superseded session's late answer applies nothing. Its own request rather than a field on
       the consent answer — `GET /mailboxes` is a different route — but deliberately the same
       CADENCE, because the two questions go stale together: another client claiming a mailbox
       writes the delta this drain just applied. */
    const boxRead = freshestRead<readonly PhoneMailbox[]>((ans) => {
      if (current.current === m) setMailboxes(ans);
    });
    const m = foldersFlag({
      read: () => {
        /* Fired from the flag's read so there is ONE cadence to reason about and one place that
           knows when facts go stale. It is NOT awaited into the flag's own promise: a mailbox
           read that is slow or refused must not hold up the folders answer, which has its own
           epoch and its own correctness. */
        void boxRead(() => readMailboxes(session));
        /* Stamped BEFORE the request leaves — the whole point of the two-phase read. */
        const applyFace = faces.beginRead();
        return sigRead(async () => {
          const ans = await readFoldersEnabled(session);
          // `null` from the read is "could not ask", which the applier must not read as "the
          // account has no face" — the two are different answers (face-scope.ts's contract).
          applyFace(ans === null ? undefined : ans.themeFace);
          return ans;
        });
      },
      write: (on) => writeFoldersEnabled(session, on),
      apply: (on) => { if (current.current === m) setFoldersOn(on); },
      drain: () => {
        if (current.current !== m) return;
        // Mid-drain the ask is OWED (see `drainOwed`); otherwise it fires now.
        if (syncingRef.current) drainOwed.current = true;
        else void syncNowRef.current();
      },
    });
    return (current.current = m);
  }, [session, setFacePin]);
  useEffect(() => {
    setFoldersOn(false);
    setFoldersPending(false);
    // The signatures are the outgoing session's answer — the next session starts unknown
    // (account A's signature must never dress account B's composer); the tracker itself is
    // rebuilt with the machine, so its tally starts over with it.
    setSignatures(null);
    // The mailboxes are the outgoing session's answer, for the signatures' reason exactly:
    // account A's addresses must not make account B's reader recognisable, and its holder must
    // not name a banner over B's mail.
    setMailboxes(null);
    /* And the FACE, for the same reason and one more: an account's appearance choice is that
       account's state, so the next session starts with none and the device's own pin (which
       outranks it either way) is deliberately left alone — it belongs to the phone, not to
       whoever is signed in on it. */
    setAccountFace(null);
    setAccountFaceKnown(false);
    setFacePending(false);
    drainOwed.current = false; // the debt was the old session's; the new one owes nothing
    if (machine) void machine.refresh();
  }, [machine]);
  const applyFaceAllDevices = useCallback(
    async (face: FaceName): Promise<boolean> => {
      const f = faceCurrent.current;
      if (!f) return false;
      setFacePending(true);
      try {
        return await f.applyAll(face);
      } finally {
        // Only the session that started the write clears its own pending flag — a session swap
        // already reset it once (the effect above) and owns it from there.
        if (faceCurrent.current === f) setFacePending(false);
      }
    },
    // `machine` is the dependency rather than `faceCurrent`: the two are built together, so this
    // callback's identity moves exactly when the session's machines are rebuilt.
    [machine],
  );
  /*
   * THE FLAG IS RE-READ AFTER EVERY COMPLETED DRAIN — the flush effect's own signal
   * (`conn.syncing` falling). The toggle is per-ACCOUNT, and another client's flip writes
   * folder creates/deletes into the very delta feed this drain just applied; holding the
   * boot-time answer for the session's whole life would show a populated mirror under a
   * stale "off" (folders invisible) or an emptied mirror under a stale "on" (a false
   * "no folders on your mail server"). One small GET per drain, epoch-guarded by the machine.
   */
  useEffect(() => {
    if (conn.syncing || !machine) return;
    // Pay the owed drain FIRST: `syncNow` is a no-op mid-drain, and the debt exists exactly
    // because the flip's folder rows were behind the last drain's cutline.
    if (drainOwed.current) {
      drainOwed.current = false;
      void syncNowRef.current();
    }
    void machine.refresh();
  }, [conn.syncing, machine]);
  const setFoldersEnabled = useCallback(
    async (on: boolean): Promise<boolean> => {
      const m = machine;
      if (!m) return false;
      setFoldersPending(true);
      try {
        return await m.set(on);
      } finally {
        // Only the session that started the write clears its own pending flag — a session
        // swap already reset it once (the effect above) and owns it from there.
        if (current.current === m) setFoldersPending(false);
      }
    },
    [machine],
  );

  const zone = useMemo(readerZone, []);
  const acts = useMemo(
    // expo-crypto's v4 — the same generator the engine composition injects (`native.ts`), taken
    // from the library directly rather than through `engine/native`: the privacy suite's
    // confinement holds that no state module imports the engine composition (the connection
    // layer is the one door), and a uuid is randomness, not network. See `LiveDeps.uuid` for
    // why a created tag's row id needs the real thing.
    /* `ownAddresses` is a GETTER through a ref, so this facade keeps ONE identity across the
       mailbox read landing — see `LiveDeps.ownAddresses`. Adding `mailboxes` to the dependency
       list instead would rebuild the facade mid-session, which is exactly what `World.worldKey`
       exists to stop effects doing. */
    () => (engine
      ? liveActions({
        engine, toast: showToast, uuid: () => Crypto.randomUUID(), zone,
        ownAddresses: () => addressesNow.current,
      })
      : null),
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
    // (When a flush DOES run with a new key beside a stuck one, the whole queue replays —
    // the engine's flush has no key filter — so a stuck key is replayed at most once per
    // flush that a new arrival participates in, under its unchanged Idempotency-Key. The
    // chain is bounded by PARTICIPATING NEW ARRIVALS: with none, nothing re-runs until the
    // next drain; each arrival buys the stuck key one replay, never a loop of its own. A
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
            // A CONFIRMED SEND-LATER DELIVERED NOTHING — the ledger carries the appointment
            // (`FlushedOutcome.sendAt`) exactly so a background flush cannot announce an
            // appointment as a delivery. The time is read in the reader's own clock, the same
            // sentence the foreground press would have spoken.
            if (o.status === "confirmed") {
              showToast(
                o.sendAt !== null ? Copy.scheduledFor(scheduleLabel(o.sendAt, new Date(), zone))
                  : o.forward ? Copy.forwarded
                    : Copy.replySent,
              );
            }
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
        // Re-run the effect ONCE, for intents that queued before this RE-CHECK observes the
        // queue (during the flush, in the settle-to-effect gap, or on a session that
        // switched in under it) — the tried-latch keeps the merely-REQUEUED batch from
        // spinning against a server that keeps refusing. An intent that queues after the
        // re-check waits for the next drain signal (`conn.syncing` falling), the same
        // signal every retry waits for: this effect deliberately has no per-mutation trigger.
        setOutcomeSeq((n) => n + 1);
      });
    // `conn.syncing` falling is the drain-completed signal; `outcomeSeq` re-checks after a flush.
    // `zone` is a mount-stable memo; it is named because the appointment sentence reads it.
  }, [conn.syncing, engine, showToast, outcomeSeq, zone]);
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
          deleteMessage: (id) => void acts.deleteMessage(id),
          sendReply: (id, body, all, sig, sendAt) => acts.sendReply(id, body, all, sig, sendAt),
          sendForward: (id, to, body, sig) => acts.sendForward(id, to, body, sig),
          cancelSchedule: (draftId) => acts.cancelSchedule(draftId),
          sendOutcome: (key) => outcomeOf(key),
          tagToggle: (id, tag, assigned) => void acts.tagToggle(id, tag, assigned),
          tagCreate: (id, name) => void acts.tagCreate(id, name),
          screenSender: (id, dest, scope) => void acts.screenSender(id, dest, scope),
          folderCreate: (mailboxId, name) => void acts.folderCreate(mailboxId, name),
          folderRename: (id, name) => void acts.folderRename(id, name),
          folderDelete: (id) => void acts.folderDelete(id),
          folderDismiss: (id) => acts.folderDismiss(id),
        }
      : NO_ACTIONS;
  /* One identity for the app's life — see the header for what per-version identity cost. */
  const actions = useMemo(() => stableActions(() => backendRef.current), []);

  /**
   * THE FRESHNESS CLOCK — current→stale is a transition TIME makes, with no drain, no store
   * write and no connection flip to re-derive the world: a phone left open past the staleness
   * threshold would render stale mail unlabeled for ever off a memo whose deps never move.
   * The beat below is bumped by the post-memo watcher whenever the engine's live verdict
   * differs from what the world actually RENDERED — see it for the three defects that
   * shaped the comparison.
   */
  const [freshBeat, setFreshBeat] = useState(0);

  const world = useMemo<World>(() => {
    if (engine === null || session === null) return emptyWorld(actions);
    const v: WorldView = {
      now: new Date(), zone, foldersEnabled: foldersOn,
      // Before the first read this is `[]`, which is `NO_OWN_ADDRESSES` — the posture this
      // client had for its whole life, and the right answer for a phone that has not asked yet.
      ownAddresses: addressesNow.current,
    };
    const pres = presentedOf(engine.read(), v.now, foldersOn);
    const ohbox = liveOhbox(pres, v);
    const reads = liveReads(pres, v);
    const receipts = liveReceipts(pres, v);
    const screener = liveScreener(pres, v, scopes);
    const piles = livePiles(pres, v);
    const pileTotal = piles.reduce((n, p) => n + p.items.length, 0);
    return {
      live: true,
      // Read per derivation, not latched: the first drain's completion stamps the mirror and
      // flips `conn.syncing`, which is in this memo's deps — so `settled` turns true in the
      // same render pass that could otherwise flash an empty state over a just-synced mailbox.
      boot: {
        settled: mirrorSettled(session.store),
        syncFailure: conn.syncError,
        // Re-read per derivation, like `settled`: a drain's settle bumps `version` (the stamp
        // write) and flips `conn.syncing`, both in this memo's deps, so the label CLEARS in the
        // same pass the mirror becomes current. The APPEARING direction is time's alone — a
        // phone sitting open crosses the threshold with no store write anywhere — so
        // `freshBeat` below ticks the memo when the verdict changes by clock.
        staleAsOf: staleAsOf(engine, zone),
      },
      worldKey: session.ownerKey,
      account: { name: session.profile.origin, email: session.profile.accountId },
      mailboxes: {
        // `known` is the SUCCESSFUL-read gate, not "the list is non-empty": an account whose
        // mailbox was removed answers `[]`, and that is an answer. The banner is drawn behind
        // this so a phone that has not asked says nothing about who organizes anything.
        known: mailboxes !== null,
        ownAddresses: addressesNow.current,
        organizer: mailboxes === null ? null : phoneOrganizer(mailboxes),
      },
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
        newCount: receipts.newCount,
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
      // Also raw, and for the same reason: a draft is not presented mail and never passes
      // through the consent cutline. `v` carries the clock the appointment is read in.
      scheduled: liveScheduled(engine.read(), v),
      folders: (() => {
        // Gated TWICE, the webapp shell's own double gate: the flag is the authority, the
        // entities are data — a mirror still holding `folder` rows after a disable lists none.
        const list = foldersOn ? liveFolders(engine.read()) : [];
        return {
          enabled: foldersOn,
          list,
          unread: foldersOn ? liveFolderUnread(pres) : new Map<string, number>(),
          byId: (id: string) => list.find((f) => f.id === id),
          items: (id: string) => {
            const f = list.find((x) => x.id === id);
            return f ? liveFolder(pres, f, v) : { fresh: [], seen: [], unread: 0, total: 0 };
          },
          pending: foldersPending,
          setEnabled: setFoldersEnabled,
          // The one read the verbs need beside the engine (`net/folder-ops.ts`): the count
          // goes to THIS session's server, and a superseded session answers "could not count".
          summary: (folderId: string) => readFolderSummary(session, folderId),
          // Only asked when there is no section to hang the first create on — one mirror
          // pass, paid exactly in the zero-folders state it serves.
          soleCreateMailboxId:
            foldersOn && list.length === 0 ? soleMessageMailbox(engine.read()) : null,
        };
      })(),
      signatures,
      face: {
        account: accountFace,
        known: accountFaceKnown,
        pending: facePending,
        applyAll: applyFaceAllDevices,
      },
      message: (id) => liveMessage(engine, id, { now: new Date(), zone, foldersEnabled: foldersOn }),
      sendOutcome: outcomeOf,
      actions,
    };
    // `version` IS the dependency that re-derives the world on every mirror change; the
    // reader itself is stable across drains, so it cannot stand in for it — and `outcomeSeq`
    // re-derives it when a reconnect flush settles a queued key, so a locked composer's
    // settle effect fires without a mirror change. `conn.syncing`/`conn.syncError` re-derive
    // the BOOT facts: the settled stamp lands as a drain completes (syncing falls), and the
    // failure sentence is part of what an unsettled screen renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, session, scopes, zone, actions, version, outcomeSeq, outcomeOf, freshBeat,
    foldersOn, foldersPending, setFoldersEnabled, signatures, conn.syncing, conn.syncError,
    accountFace, accountFaceKnown, facePending, applyFaceAllDevices]);

  /**
   * THE FRESHNESS WATCHER — the clock's other half, AFTER the memo because its sentinel IS the
   * memo's own output. It compares what the engine would say now against what the world
   * rendered (`boot.staleAsOf`), at arm time and then each minute, and bumps `freshBeat` only
   * on a difference. Three defects shaped this exact form:
   *
   *  · round 2 — no formatted-label ambiguity is possible: both sides of the comparison come
   *    from the same derivation, so "a different stamp that happens to format identically"
   *    cannot make a real transition invisible (a stamp change requires a drain, which
   *    re-derives through `version` anyway);
   *  · round 3 — a healthy drain's stamp churn re-arms and re-renders NOTHING: while current,
   *    the rendered label is null across every drain, the dep does not move, and the check
   *    compares null with null;
   *  · round 4 — a transition can never be swallowed UNRENDERED: a ref seeded from the live
   *    verdict could adopt a current→stale flip that happened between render and effect and
   *    then never announce it; comparing against the RENDERED value makes that impossible by
   *    construction — the check at arm time closes the same race.
   *
   * RN pauses timers in the background; on return, the next tick or the foreground drain
   * re-derives, whichever lands first. A bump re-derives the memo, the dep follows, the
   * re-armed check finds both sides equal, and the loop terminates in one step.
   */
  const renderedStale = world.boot.staleAsOf;
  useEffect(() => {
    if (engine === null) return;
    const check = (): void => {
      if (staleAsOf(engine, zone) !== renderedStale) setFreshBeat((n) => n + 1);
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [engine, zone, renderedStale]);

  return (
    <WorldContext.Provider value={world}>
      <WorldToastContext.Provider value={worldToast}>{children}</WorldToastContext.Provider>
    </WorldContext.Provider>
  );
}
