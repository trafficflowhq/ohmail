/**
 * The world layer — one hook the mail screens render from. `useWorld()` answers the connected
 * session's mirror through the shared client-engine selectors (`src/state/live.ts`): reads over
 * the consent projection, `engine.mutate` behind every action, watched ({@link useWorldToast}).
 * Without a live session the world is empty — no account, no-op actions; honestly nothing,
 * never sample data (the navigation gate keeps mail screens off-screen; the empty world covers
 * a deep link restored mid-boot). Computed once per change (the engine's version signal) and
 * shared through context — six consumers re-deriving five piles per render would scan the
 * mirror thirty times per drain tick. `world.actions` is one object for the app's life.
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
import { refuse, type RefusalArg } from "../refusal";
import { useLocale } from "../i18n/LocaleProvider";
import { useConnection } from "../net/connection";
import {
  readFoldersEnabled,
  writeFoldersEnabled,
  writeThemeFace,
  type FoldersConsent,
} from "../net/consent";
import { readMailboxes, type PhoneMailbox } from "../net/mailboxes";
import { junkFolderSaid } from "./folders";
import { readScreenerWaiting, type ServerWaitingSender } from "../net/screener";
import { PHONE_CLAIM_NAME, organizesHere } from "../engine/standalone-door";
/* THE DOOR ANSWERING FOR ITSELF, with no request — `organizer-session.ts` holds the one engine
   this process runs and `standaloneHere` is its read. The state module reaches into `engine/`
   for exactly this and nothing else: the alternative is a second copy of the connection facts
   kept in React, and a second copy is a second writer. */
import { standaloneHere } from "../engine/organizer-session";
import { readFolderSummary } from "../net/folder-ops";
import * as Crypto from "expo-crypto";
import type { FaceName } from "../theme/face";
import { faceScope } from "./face-scope";
import { foldersFlag, freshestRead } from "./folders-flag";
import { usePrefs } from "./store";
import {
  connectionSay, firstSyncSay,
  flushQueued,
  liveActions,
  liveFolder,
  liveFolders,
  liveFolderUnread,
  liveHistory,
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
  presentedWorld,
  scheduleLabel,
  screeningAnswered,
  SCREENING_UNANSWERED,
  SCREENING_UNSUPPLIED,
  staleAsOf,
  readerZone,
  soleMessageMailbox,
  stableActions,
  type FolderEntity,
  type ScreenerRow,
  type AbandonedMutation,
  type MutationResult,
  type WorldActions,
  type WorldHistory,
  type PhoneOrganizer,
  type WorldMail,
  type WorldPile,
  type WorldScheduled,
  type ScreeningPosture,
  type WorldScreener,
  type WorldTag,
  type WorldView,
  type ConnectionSay,
  type FirstSyncSay,
} from "./live";
import type { Scope } from "./model";

export type {
  FolderEntity, MoveTarget, PhoneOrganizer, ScreenerRow, WorldActions, WorldHistory, WorldMail,
  WorldPile, WorldScheduled, WorldScreener, WorldTag,
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
    syncFailure: RefusalArg | null;
    /**
     * The stale label's sentence-ready time ("Fri 09:00", the reader's zone), or null when the
     * mirror is current or has never settled — `live.ts#staleAsOf`, the Freshness Contract's
     * middle state. Non-null means the chrome owes "As of <time> · catching up" until a drain
     * settles; the derivation clears it in the same world re-derive that applies the drain.
     */
    staleAsOf: string | null;
    /**
     * WHETHER THE MAIL SERVER CAN BE REACHED — the engine's own answer, ranked into one verdict
     * (`live.ts#connectionSay`). `null` is "nothing has said": a paired session, a build with no
     * engine, or a door whose first cycle has not run.
     *
     * It sits beside `staleAsOf` because it OUTRANKS it on screen. Through a measured
     * two-and-a-half-minute outage the only sentence anywhere was the freshness stamp — true,
     * and the reader could not learn from it that nothing was dialling.
     */
    connection: ConnectionSay | null;
    /**
     * AND WHAT THE FIRST SYNC OF THIS MAILBOX PRODUCED — `live.ts#firstSyncSay`, ranked the same
     * way and carried BESIDE the link's verdict rather than inside it. `null` is "nothing has
     * said". Two surfaces read it and they must not disagree: the This-phone panel renders its
     * sentence, and the Ohbox's empty state chooses between "no mail" and "nothing readable yet"
     * — the line that told a person their mail "lands here as it syncs" over a mailbox where
     * nothing ever had.
     */
    firstSync: FirstSyncSay | null;
  };
  /**
   * Changes the server would not take — the phone's half of the web's "could not be saved"
   * strip. Parity is a rule, not a nicety: the engine gives up on a verb after a bounded number
   * of server-answered failures and moves it out of the replay set, so a phone that did not
   * render this list would drop the user's work silently while the browser explained it. Read
   * per derivation from the engine's value-cached `abandoned()`, so it is correct on the first
   * render after a boot — when nothing has been dispatched and the only evidence is on disk.
   */
  abandoned: readonly AbandonedMutation[];
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
   * Is this session the engine in this app — the standalone door, rather than a server on a
   * wire. `ConnectedSession.standalone`, carried through unchanged: the connection layer
   * derives it from the session's origin — the one thing `bootEngine` refuses a local engine
   * off — and derives it there so no screen or state module reaches into `engine/`
   * (`privacy.test.ts`). `false` while nothing is live, the same answer as a paired session.
   * What it decides today: send-later appointments — this install organizes only while ohmail
   * is running on it, so it keeps none (`sendLaterOffered`, and the engine's own 409).
   */
  standalone: boolean;
  /**
   * The mailbox facts — `GET /mailboxes` over the paired server (`src/net/mailboxes.ts`), on
   * the folders flag's cadence (boot + after every completed drain). `known` separates "the
   * account has no mailboxes" from "nobody has asked yet", and it is the gate the reader
   * banner is drawn behind — a phone that has not read yet must say nothing about who
   * organizes anything. It goes true on the first successful read and stays true for the
   * session; a later failure keeps the last known answer rather than blanking a banner on a
   * flaky request (`readMailboxes` returns `null` for "could not ask", never an empty list).
   */
  mailboxes: {
    known: boolean;
    /** Every mailbox address on the account — the reader's own, for `canReplyAll` and reply-all. */
    ownAddresses: readonly string[];
    /** Who organizes them, when one holder organizes all of them and is named. */
    organizer: PhoneOrganizer | null;
    /**
     * THE ROWS THE READ ALREADY FETCHED — kept rather than discarded after deriving `organizer`.
     *
     * Settings → This phone names a mailbox by ADDRESS and hands it back by ID, and neither is
     * derivable from `organizer` or `ownAddresses`. The read has both; it was throwing them away.
     * Empty where nothing has been read, which `known` is what distinguishes.
     */
    rows: readonly PhoneMailbox[];
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
  screener: WorldScreener & { meta: string };
  /**
   * History — mail from senders nobody ever decided about, who then went quiet. The other arm
   * of the partition that fills `screener.waiting`, derived from the same `presentedWorld`
   * call so a sender is in exactly one of the two; before this existed the retired half of a
   * mailbox was in no list at all. `meta` is the browser's own count line. No badge and no
   * unread number anywhere: History is all read by construction (an unread message makes its
   * sender active, so it queues in the Screener instead), which is why the nav entry beside
   * it carries no count.
   */
  history: WorldHistory & { meta: string };
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
    /**
     * Whether the paired server can KEEP a folders choice — `GET /consent` carrying the
     * `foldersEnabledAt` axis at all (`net/consent.ts#FoldersConsent.storable`). False on every
     * door built from `localRoutes`, which serves no folder verb and removes the field: there
     * Settings withholds the control instead of drawing one whose write is dropped. Never gates
     * the LIST — {@link enabled} is the authority for what renders.
     */
    storable: boolean;
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
    /**
     * WHAT THE GROUP'S FOOT SAYS ABOUT THE PROVIDER'S JUNK FOLDER — ohmail never mirrors
     * `\Junk`, so junked mail is in no list here and the person hunting for it is owed the
     * name of the place it went ({@link junkFolderSaid}). `null` is "say nothing": no Junk
     * folder, nothing attached yet, or a server that predates the field.
     */
    junkSaid: { named: string } | "unnamed" | null;
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
     * Has the account's face been read at all this session? `account: null` means two things
     * until this is true — "no preference" and "nobody asked yet" — and the account-wide write
     * must not fire on the second: with no device pin the control shows paper, and pressing
     * "apply on all devices" would PATCH paper over an ohmarchy the account really holds while
     * its read was slow or failing. The webapp carries the same fact as `themeFaceKnown`.
     * True once an answer has been adopted — a successful read, or a write's own echo. A read
     * the coordinator refused does not count: the conservative direction, since the gated act
     * is precisely the one that must not run on a value nobody trusts.
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
  toast: { id: number; say: RefusalArg } | null;
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
  // The empty world has no engine and nothing queued; the resolved promise keeps the facade's
  // shape honest for a caller that awaits it.
  // The empty world has no engine; the shape is kept honest for a caller that reads the result.
  retryAbandoned: async (id: string) => ({ id, key: id, status: "rolled_back" as const, seq: null }),
  discardAbandoned: async () => undefined,
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

const EMPTY_ABANDONED: readonly AbandonedMutation[] = Object.freeze([]);

/**
 * HOW OFTEN THE LIVE-VERDICT WATCHER RE-READS — the engine's own poll cadence.
 *
 * Both verdicts it watches change with no store write and no state flip, so this interval is the
 * only thing that notices them. It is the poll's cadence rather than a minute because the phone
 * calls a connection dead in 45 s, and a sentence a minute behind that detection is a sentence
 * arriving after the person has already put the phone down.
 */
const LIVE_VERDICT_BEAT_MS = 15_000;

function emptyWorld(actions: WorldActions): World {
  return {
    live: false,
    boot: { settled: false, syncFailure: null, staleAsOf: null, connection: null, firstSync: null },
    // Nothing is queued on the empty world, so nothing was given up on. `EMPTY_ABANDONED` rather
    // than a fresh `[]`: this object is compared by identity in places, and a new array per call
    // is the same re-render trap `useAbandoned` avoids on the web.
    abandoned: EMPTY_ABANDONED,
    worldKey: "none",
    account: { name: "", email: "" },
    standalone: false,
    // Nothing has been asked on the empty world, so `known` is false and the banner is withheld
    // — the same honest-unknown the boot facts keep between a teardown and the redirect.
    mailboxes: { known: false, ownAddresses: [], organizer: null, rows: [] },
    ohbox: { resurfaced: [], fresh: [], seen: [], unread: 0, total: 0, meta: "" },
    doorbell: { initials: [], count: 0 },
    reads: { items: [], waterlineAboveId: null, waterLabel: Copy.waterline, newCount: 0, meta: "" },
    receipts: { groups: [], waterlineAboveId: null, waterLabel: Copy.waterline, total: 0, newCount: 0, meta: "" },
    screener: { waiting: [], screened: [], spam: [], meta: "", source: "device", waitingPending: false },
    history: { items: [], total: 0, meta: "", pending: false },
    piles: [],
    pilesMeta: "",
    tags: [],
    scheduled: [],
    folders: {
      enabled: false,
      // Nothing is connected, so no door has said it cannot keep one: today's interface.
      storable: true,
      list: [],
      unread: new Map(),
      byId: () => undefined,
      items: () => ({ fresh: [], seen: [], unread: 0, total: 0 }),
      pending: false,
      setEnabled: () => Promise.resolve(false),
      // Could-not-count, honestly: nothing is connected, so nothing can be counted.
      summary: () => Promise.resolve(null),
      soleCreateMailboxId: null,
      // Nothing is connected, so no mailbox has been read and there is no folder to name.
      junkSaid: null,
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
  const [toastQueue, setToastQueue] = useState<{ id: number; say: RefusalArg }[]>([]);
  const toastSeq = useRef(0);
  const showToast = useCallback((say: RefusalArg) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToastQueue((q) => (q.length >= 4 ? q : [...q, { id, say }]));
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
   * DOES THE PAIRED SERVER CARRY THE FOLDERS SETTING AT ALL (`FoldersConsent.storable`) —
   * a different question from {@link foldersOn}, which is what the account chose. TRUE until a
   * successful read says otherwise: that is today's interface, and it cannot mislead, since the
   * flag itself is off until a server answers. A door built from `localRoutes` — the desktop host
   * this phone pairs with, an operator's self-host server, this app's own standalone door — has no
   * folders axis and omits the field; there the Settings control is withheld rather than drawn over
   * a write the server will drop. Reset with the flag on a session swap: account A's door says
   * nothing about account B's.
   */
  const [foldersStorable, setFoldersStorable] = useState(true);
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
   * THE ACCOUNT'S CUTLINE ANSWER AND WHETHER IT IS IN — {@link ScreeningPosture}, riding the
   * signatures' read and their exact rule (freshest-successful-read-wins, identity-gated).
   *
   * A session starts `unanswered`, and the piles the answer decides are withheld until it
   * settles: the only posture this client can partition by meanwhile is `all_time`, which admits
   * MORE senders than any answer will, so the queue was painted wide and then shrank. A read that
   * lands with none of the three fields settles it `unsupplied` — an answer, not a wait. Reset on
   * a session swap: account A's window must not partition account B's mirror.
   */
  const [screening, setScreening] = useState<ScreeningPosture>(SCREENING_UNANSWERED);
  /**
   * The account's mailboxes, or `null` until a read succeeds this session (what
   * {@link World.mailboxes.known} publishes). Nothing on this phone ever writes a mailbox, so
   * freshest-successful-read-wins is the whole rule — the signatures' exact situation, using
   * the same `freshestRead` wrapper for the same race: two overlapping reads settling out of
   * issue order. A session swap resets it to `null` below, beside the signatures and the face:
   * account A's mailbox addresses must never make account B's reader recognisable, which is
   * why this is state rather than a ref.
   */
  const [mailboxes, setMailboxes] = useState<readonly PhoneMailbox[] | null>(null);
  /**
   * The waiting queue as the server holds it (`GET /screener`), or `null` until a read succeeds
   * this session — and `null` for the whole life of a STANDALONE session, where this phone is the
   * engine and there is no second answer to ask for. `null` is "nobody answered", and
   * `liveScreener` then shows the partition's own list and says so. Never an empty list on failure,
   * for `readMailboxes`' reason: an empty queue is a real answer, and reading a refusal as one
   * would empty the Screener on a flaky request. Reset on a session swap beside the mailboxes —
   * account A's waiting senders must never be account B's queue.
   */
  const [screenerServer, setScreenerServer] = useState<readonly ServerWaitingSender[] | null>(null);
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
   * One {@link foldersFlag} machine per session — closes over `session` at construction, so a
   * machine from a superseded session cannot write. Rebuilt only when the session identity
   * changes; `useMemo` rather than a ref because the machine's epoch must reset to "no write
   * yet" for a fresh session. `apply` is gated on identity, not merely the machine's own
   * epoch: a session swap builds a new machine, but the old machine's in-flight read or write
   * can still resolve afterwards — its own epoch says nothing about a session that replaced
   * it. `current` always names the live machine, so a stale settle applies nothing (the same
   * discipline the outcome ledger and the reconnect flush carry).
   */
  const current = useRef<ReturnType<typeof foldersFlag> | null>(null);
  /**
   * One {@link faceScope} per session, beside the folders machine and built with it — it
   * closes over the same `session`, so a superseded machine cannot write to a server the app
   * has left, and its epoch resets for a fresh session exactly like `accountFace`. It rides
   * the folders machine's `GET /consent` rather than issuing its own: the read already happens
   * at boot and after every drain, and a second request for a field the first carries would be
   * a new mechanism for nothing. What the face needs on top is the issue stamp — `beginRead()`
   * before the fetch, its applier after; `face-scope.ts` has the race that shape exists for.
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
      if (current.current !== m) return;
      setSignatures(ans.signatures);
      /* The cutline half of the SAME answer — see `screening` above. A read that landed with no
         cutline fields is `unsupplied`, NOT still-waiting: nothing further is coming from this
         server, so the piles stop being withheld and stand at "retire nobody". */
      setScreening(ans.screening === null ? SCREENING_UNSUPPLIED : screeningAnswered(ans.screening));
      // …and whether this door carries the folders axis, off the same body and on the same
      // freshest-successful-read-wins rule: the machine's epoch guards the FLAG against the
      // user's write, and nothing on this phone writes a capability.
      setFoldersStorable(ans.storable);
    });
    /* THE MAILBOX READ, built beside the folders machine and gated on the SAME identity: a
       superseded session's late answer applies nothing. Its own request rather than a field on
       the consent answer — `GET /mailboxes` is a different route — but deliberately the same
       CADENCE, because the two questions go stale together: another client claiming a mailbox
       writes the delta this drain just applied. */
    const boxRead = freshestRead<readonly PhoneMailbox[]>((ans) => {
      if (current.current === m) setMailboxes(ans);
    });
    /* THE QUEUE READ, beside the mailbox read and on the same identity and cadence: the two go
       stale together, because the drain this fires after is the one that landed the moves the
       queue is derived from. Its own route, its own epoch — a refused queue read must not hold
       up the folders answer or the roster, and each keeps the last thing it knew. */
    const queueRead = freshestRead<readonly ServerWaitingSender[]>((ans) => {
      if (current.current === m) setScreenerServer(ans);
    });
    const m = foldersFlag({
      read: () => {
        /* Fired from the flag's read so there is ONE cadence to reason about and one place that
           knows when facts go stale. It is NOT awaited into the flag's own promise: a mailbox
           read that is slow or refused must not hold up the folders answer, which has its own
           epoch and its own correctness. */
        void boxRead(() => readMailboxes(session));
        /* ONLY A PAIRED DOOR HAS A SERVER TO ASK. On the standalone door this app IS the engine:
           the partition is the only authority that exists there, and a request for a route this
           session does not dial would refuse on every cadence for ever. */
        if (!session.standalone) void queueRead(() => readScreenerWaiting(session));
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
    // The door's capability is the outgoing session's answer too; the next session starts at
    // today's interface until its own read lands.
    setFoldersStorable(true);
    // The signatures are the outgoing session's answer — the next session starts unknown
    // (account A's signature must never dress account B's composer); the tracker itself is
    // rebuilt with the machine, so its tally starts over with it.
    setSignatures(null);
    // …and the cutline answer, for the same reason: a window read off account A must never
    // decide which of account B's senders are worth a decision. Back to `unanswered`, the state
    // a session that has asked nothing yet is actually in.
    setScreening(SCREENING_UNANSWERED);
    // The mailboxes are the outgoing session's answer, for the signatures' reason exactly:
    // account A's addresses must not make account B's reader recognisable, and its holder must
    // not name a banner over B's mail.
    setMailboxes(null);
    // And the queue, for the mailboxes' reason exactly: account A's waiting senders are not
    // account B's, and a stale set would name senders whose mail this mirror does not hold.
    setScreenerServer(null);
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
  /*
   * WHICH LANGUAGE THE ENGINE NAMES A DAY IN — the seam `live.ts` already had and nothing ever
   * filled. Every date the mirror puts on screen goes through `messageDisplayTime`,
   * `receiptsByDay` and `screenerSegments`, each of which takes a locale and defaulted to `"en"`
   * because this view never passed one; a German phone was reading "Fri" and "2 Aug".
   * `useLocale()` also SUBSCRIBES, so a language switch rebuilds the view rather than leaving the
   * stamps in the language they were first derived in — the memo lists it as a dependency for
   * exactly that.
   */
  const locale = useLocale();
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
   * The reconnect flush. A retryable rejection parks its mutation on the engine's queue under
   * its Idempotency-Key, and `flushPending` had no caller in this app — a queued intent stood
   * forever while its toast said "still trying". The proof the server is reachable again is a
   * drain completing (`conn.syncing` falling with no error), so the queue flushes here, with
   * the same keys — which is what makes the retry unable to double-deliver. It lives in the
   * world layer, not the connection, because the two things a terminal outcome owes are both
   * here: the toast, and the ledger a locked composer settles from.
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
                o.sendAt !== null ? refuse("scheduledFor", scheduleLabel(o.sendAt, new Date(), zone)) : o.forward ? refuse("forwarded") : refuse("replySent"),
              );
            }
            else if (o.status === "unverified") showToast(refuse("replyUnverified"));
            else showToast(refuse("replyFailed"));
          } else if (o.status === "rolled_back") {
            showToast(refuse("liveSaveFailed"));
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
          retryAbandoned: (id) => acts.retryAbandoned(id),
          discardAbandoned: (id) => acts.discardAbandoned(id),
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
          screenSender: (id, dest, scope, applyRetro) => void acts.screenSender(id, dest, scope, applyRetro),
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

  /**
   * THE ENGINE IS TOLD THE SAME CUTLINE THE PARTITION BELOW IS DRAWN WITH.
   *
   * This phone's mirror is a window (`MOBILE_WINDOW`), so it decides dormancy from the mail it
   * kept while the server decides it from the whole account. They agree only while the mirror
   * holds every message the cutline reads — and the dormancy dial reaches 365 days against a
   * 90-day window, so a sender whose only mail the window evicted would be retired into History
   * here and still queued there. The engine widens its retention to cover the answer; `maxRows`
   * still decides the size. `null` (unanswered, and every session swap) is the pre-cutline
   * window exactly, which is the same posture `presentedWorld` takes on the same value.
   */
  useEffect(() => {
    if (engine === null) return;
    /* ONLY AN ANSWER IS A CUTLINE. `unanswered` is the read still outstanding and `unsupplied` is
       a server that carries none of the three fields — neither is a cutoff, and handing the engine
       one built from either is the wide guess this posture exists to stop. */
    engine.setCutline(screening.state === "answered"
      ? { dormancyDays: screening.answer.dormancyDays, scope: screening.answer.scope }
      : null);
  }, [engine, screening]);

  const world = useMemo<World>(() => {
    if (engine === null || session === null) return emptyWorld(actions);
    /* THE STANDALONE DOOR HAS NOBODY TO ASK — this app IS the engine there and `GET /consent` is
       a route this session does not dial (the same fact the queue read is skipped for, below).
       Waiting for an answer that can never arrive would withhold the Screener for the life of
       the session, so that door is `unsupplied`: settled, retiring nobody, marked as nothing. */
    const posture: ScreeningPosture = session.standalone ? SCREENING_UNSUPPLIED : screening;
    const v: WorldView = {
      now: new Date(), zone, locale, foldersEnabled: foldersOn,
      // Before the first read this is `[]`, which is `NO_OWN_ADDRESSES` — the posture this
      // client had for its whole life, and the right answer for a phone that has not asked yet.
      ownAddresses: addressesNow.current,
      /* The rows behind those addresses, so a message can name the mailbox it arrived in. `?? []`
         is "nothing read yet", which the label gate reads as nothing to disambiguate. */
      mailboxes: mailboxes ?? [],
      // The SAME posture the partition below is taken under — the shelves read it for the marker.
      screening: posture,
    };
    /* ONE partition, both arms (`live.ts#presentedWorld`): `world.reader` is the projection the
       piles group over, `world.history` is the mail the cutline retired. Two calls would be one
       rule read at two clocks — a sender in both lists, or in neither. */
    const world = presentedWorld(engine.read(), v.now, foldersOn, posture, addressesNow.current);
    const pres = world.reader;
    const ohbox = liveOhbox(pres, v);
    const reads = liveReads(pres, v);
    const receipts = liveReceipts(pres, v);
    /* THE PAIRED DOOR'S QUEUE IS THE SERVER'S SET — see `liveScreener`. `null` here is the
       standalone door and a paired door that has not been answered yet; the derived list then
       stands and the meta below says the count was worked out on this phone. */
    const screener = liveScreener(pres, v, scopes, screenerServer);
    /* The RAW mirror, not `pres`: the projection deletes History's rows, which is what makes
       History a presentation rather than a folder. See `liveHistory`. */
    const history = liveHistory(engine.read(), world.history, v);
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
        // Re-read per derivation, like `settled`: a drain's settle flips `conn.syncing`, which
        // is in this memo's deps, so the label clears in the same pass the mirror becomes
        // current. The completion stamp no longer bumps the mirror `version` (`setMeta`,
        // `packages/client-engine/src/store.ts` — an idle client was rebuilding its whole view
        // once per poll to record a timestamp), so `conn.syncing` carries the clearing. Not
        // "silently stop": `freshBeat` below ticks this memo on its own minute cadence, so
        // removing `conn.syncing` from the deps would delay the clear to the next tick, not
        // prevent it. The appearing direction is time's alone — a phone sitting open crosses
        // the threshold with no store write — so `freshBeat` ticks when the verdict changes.
        staleAsOf: staleAsOf(engine, zone),
        /* THE DOOR'S OWN WORD, re-read per derivation like the two above. It is NOT in this
           memo's dependency array and cannot be: `standaloneHere` reads module state, not React
           state, so there is nothing here to depend on. The watcher below is what re-derives
           when it moves — the same one the stale label uses, the same beat, one writer. */
        connection: connectionSay(standaloneHere(), v.now, zone),
        /* ONE read of the door for both verdicts would be one call; this is a second call to the
           same module state in the same synchronous derivation, which is one moment. See the
           field: they are two facts and both are rendered. */
        firstSync: firstSyncSay(standaloneHere()),
      },
      abandoned: engine.abandoned(),
      worldKey: session.ownerKey,
      /**
       * Whose mail this is — and the standalone door has no address to name. On every paired
       * door these two fields are a server address and the account it opens. On the standalone
       * door the origin is `LOCAL_ENGINE_ORIGIN` — a name nothing dials — and the id is opaque,
       * so the header read as a URL and a UUID to a person whose mailbox is on the phone in
       * their hand (measured on a device). The same two facts in this door's words: the phone's
       * own claim name, and the mailbox the engine says it serves. The address comes from the
       * row, because the profile has never held one; an unread roster leaves it empty.
       */
      account: organizesHere(session.profile)
        ? { name: PHONE_CLAIM_NAME, email: mailboxes?.[0]?.address ?? "" }
        : { name: session.profile.origin, email: session.profile.accountId },
      // THE DOOR, derived once by the layer that composes the session. See the field.
      standalone: session.standalone,
      mailboxes: {
        // `known` is the SUCCESSFUL-read gate, not "the list is non-empty": an account whose
        // mailbox was removed answers `[]`, and that is an answer. The banner is drawn behind
        // this so a phone that has not asked says nothing about who organizes anything.
        known: mailboxes !== null,
        ownAddresses: addressesNow.current,
        organizer: mailboxes === null ? null : phoneOrganizer(mailboxes),
        /* The same value `known` and `organizer` are derived from, so the three cannot disagree:
           `freshestRead` keeps the last successful answer, and a failed read changes none of them. */
        rows: mailboxes ?? [],
      },
      ohbox: { ...ohbox, meta: Copy.metaUnreadOf(ohbox.unread, ohbox.total) },
      doorbell: {
        initials: screener.waiting.map((r) => r.initial),
        count: screener.waiting.length,
      },
      reads: {
        ...reads,
        waterLabel: Copy.waterline,
        meta: Copy.metaNew(reads.newCount),
      },
      receipts: {
        groups: receipts.groups,
        waterlineAboveId: receipts.waterlineAboveId,
        waterLabel: Copy.waterline,
        total: receipts.total,
        newCount: receipts.newCount,
        meta: Copy.metaNew(receipts.newCount),
      },
      screener: {
        ...screener,
        // A number this phone derived is never shown as the mailbox's own.
        meta: screener.source === "server"
          ? Copy.metaWaiting(screener.waiting.length)
          : Copy.metaWaitingOnDevice(screener.waiting.length),
      },
      history: { ...history, meta: Copy.historyMeta(history.total) },
      piles,
      pilesMeta: Copy.metaItems(pileTotal),
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
          storable: foldersStorable,
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
          // Off the MAILBOX facts, not the entities: `\Junk` is excluded from the inventory
          // whole, so no `folder` entity can ever carry it. `null` while the roster has not
          // been read — an unasked question is not the answer "there is no Junk folder".
          junkSaid: junkFolderSaid(mailboxes ?? []),
        };
      })(),
      signatures,
      face: {
        account: accountFace,
        known: accountFaceKnown,
        pending: facePending,
        applyAll: applyFaceAllDevices,
      },
      /* THE SAME VIEW THE LISTS WERE DERIVED FROM, field for field. It used to carry the clock,
         the language and the folders flag alone, so the reading screen projected the mirror under
         a different cutline than the list that linked to it (a row the list showed could answer
         "no longer here") and resolved reply-all against an EMPTY own-address set, which leaves
         the reader in the audience of their own reply. */
      message: (id) => liveMessage(engine, id, {
        now: new Date(), zone, locale, foldersEnabled: foldersOn,
        ownAddresses: addressesNow.current, mailboxes: mailboxes ?? [], screening: posture,
      }),
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
  }, [engine, session, scopes, zone, locale, actions, version, outcomeSeq, outcomeOf, freshBeat,
    foldersOn, foldersPending, foldersStorable, setFoldersEnabled, signatures, screening, screenerServer, conn.syncing,
    conn.syncError, accountFace, accountFaceKnown, facePending, applyFaceAllDevices]);

  /**
   * The freshness watcher — the clock's other half, after the memo because its sentinel IS the
   * memo's output. It compares what the engine would say now against what the world rendered
   * (`boot.staleAsOf`), at arm time and each tick, bumping `freshBeat` only on a difference. Both
   * sides come from one derivation, so no label-format ambiguity is possible and a healthy drain
   * compares null with null; comparing against the RENDERED value means a current→stale flip
   * between render and effect cannot be swallowed. The connection verdict rides the SAME watcher —
   * a lost link moves no store version and flips no state, so a second beat would be a second writer
   * of one world — and the interval is the ENGINE'S POLL CADENCE so the sentence isn't a minute late.
   */
  const renderedStale = world.boot.staleAsOf;
  /* The verdict's own SHAPE, not the object: `connectionSay` answers a fresh record per call, so
     comparing references would bump the beat on every tick and re-derive the whole world four
     times a minute over a healthy link. */
  const renderedConnection = JSON.stringify([world.boot.connection, world.boot.firstSync]);
  useEffect(() => {
    if (engine === null) return;
    const check = (): void => {
      const staleMoved = staleAsOf(engine, zone) !== renderedStale;
      const connMoved = JSON.stringify(
        [connectionSay(standaloneHere(), new Date(), zone), firstSyncSay(standaloneHere())],
      ) !== renderedConnection;
      /* ONE bump for either, so the loop still terminates in one step: the re-derive re-reads
         BOTH verdicts, and the re-armed check finds both sides equal. */
      if (staleMoved || connMoved) setFreshBeat((n) => n + 1);
    };
    check();
    const id = setInterval(check, LIVE_VERDICT_BEAT_MS);
    return () => clearInterval(id);
  }, [engine, zone, renderedStale, renderedConnection]);

  return (
    <WorldContext.Provider value={world}>
      <WorldToastContext.Provider value={worldToast}>{children}</WorldToastContext.Provider>
    </WorldContext.Provider>
  );
}
