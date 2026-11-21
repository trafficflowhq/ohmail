/**
 * WHAT A FEATURE REACHES OF THE FRAME, and nothing else: the frame's api (its host, the route, the plan, the
 * named commands, the report), one notice feed of its own, and the report slot. Today's views also feed the
 * rail's model and the connection's readings, until their own places register.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ToastFn } from "@ohmail/app-logic/press/report";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";
import type { LinkedDraft } from "../host/index.js";
import type {
  FrameApi,
  FrameNotice,
  OfferFeed,
  OfferSource,
  PaletteOffer,
  RailFootModel,
  RailModel,
  StageId,
} from "./contract.js";
import { fragmentOf } from "./route.js";
import { useSignal, type Feed } from "./feeds.js";
import { shapeOf, type OfferStore } from "./offers.js";
import type { NoticeStore } from "./notice-store.js";
import type { Dragging } from "./rail-drag.js";

/** What the shell's views know of the connection that the contract does not carry. */
/**
 * A shell's own words for the state the frame names: why a mailbox is blocked, who files it, why a filing waits.
 * `title` and `line` replace the frame's; `href` is where the state's act leads instead of Settings' Mailboxes.
 */
export interface ConnectionReason {
  readonly title?: string;
  readonly line?: string;
  readonly href?: string;
}

export interface ConnectionFeed {
  readonly mail: MailState | null;
  readonly online: boolean;
  /** Where a person with no mailbox is led to connect one: the setup flow, or null for Settings' Mailboxes. */
  readonly setupHref: string | null;
  readonly reason?: ConnectionReason | null;
  /** When the copy on screen last finished a sync (the host's copy-age read, the engine's own stamp where it gives none). */
  readonly copyAsOf?: string | null;
  /** Leads to an address the shell's words name (the setup flow, a reason's place, the host's link), the shell's way. */
  readonly follow: (href: string) => void;
}

/** What the slot reads while no part feeds the connection: nothing to say, and nowhere to lead. */
export const NO_CONNECTION: ConnectionFeed = {
  mail: null,
  online: true,
  setupHref: null,
  reason: null,
  follow: () => undefined,
};

export interface EnteredTarget {
  readonly fragment: string;
  readonly letter: string;
}

export interface CalendarGuest {
  readonly address: string;
  readonly name: string | null;
}

export interface CalendarDraftSeed {
  readonly title?: string;
  readonly guests: readonly CalendarGuest[];
}

export interface ReaderPosition {
  readonly address: string;
  readonly top: number;
  readonly square: string | null;
}

export interface FrameInner {
  readonly api: FrameApi;
  readonly initialPlace?: boolean;
  readonly notices: NoticeStore;
  readonly rail: Feed<RailModel | null>;
  /** The rail's foot, fed apart from the places; read where no whole rail is fed. */
  readonly foot: Feed<RailFootModel | null>;
  readonly connection: Feed<ConnectionFeed>;
  /** A letter handed to `write`, taken once by the place that writes. */
  readonly draft: { current: LinkedDraft | null };
  readonly calendarDraftSeed: { current: CalendarDraftSeed | null };
  /** The letter a `go` named as entered, until the place that lists it takes the word or the address moves on. */
  readonly entered: Feed<EnteredTarget | null>;
  readonly readerOpen?: number;
  readonly readerPosition: { current: ReaderPosition | null };
  readonly searchQuery: { current: string };
  /** Whether the whole rail stands over the app, and its setter (`commands.rail` is the same setter). */
  readonly railOpen: readonly [boolean, Dispatch<SetStateAction<boolean>>];
  /** The parts whose selection's bar stands now, by their own id. */
  readonly bars: Feed<readonly string[]>;
  /** The parts that say a stage is owed now, each by its own id ({@link useStageOwed}). */
  readonly owed: Feed<readonly StageOwing[]>;
  /** The palette's offers, by the part that hands them. */
  readonly offers: OfferStore;
  /** A letter dragged from a list toward the rail, past its threshold (`rail-drag.ts`), or none. */
  readonly drag: Feed<Dragging | null>;
}

/** One part's word that a stage is owed. */
export interface StageOwing {
  readonly part: string;
  readonly id: StageId;
}

export const FrameContext = createContext<FrameInner | null>(null);

export function useReaderOpen() {
  return useInner().readerOpen ?? 0;
}

export function useReaderPosition() {
  return useInner().readerPosition;
}

export function useResumingReader(): ReaderPosition | null {
  const { api, readerPosition } = useInner();
  const last = readerPosition.current;
  return api.previousProduct === "cal" && last?.address === fragmentOf(api.route) ? last : null;
}

function useInner(): FrameInner {
  const inner = useContext(FrameContext);
  if (!inner) throw new Error("a part of the frame was drawn outside the frame");
  return inner;
}

/** The drag toward the rail: written by the gesture, read by the entries that take a drop. */
export function useDragFeed(): Feed<Dragging | null> {
  return useInner().drag;
}

/** Search text kept for the lifetime of this account’s frame. */
export function useSearchQuery() {
  return useInner().searchQuery;
}

export function useCalendarDraftSeed(): FrameInner["calendarDraftSeed"] {
  return useInner().calendarDraftSeed;
}

export function useFrame(): FrameApi {
  return useInner().api;
}

/** The report slot: the press seam's report function, so Undo reaches it unchanged. */
export function useReport(): ToastFn {
  return useInner().api.report;
}

/** A notice rendered on its own has no application report slot. */
export function useOptionalReport(): ToastFn | null {
  return useContext(FrameContext)?.api.report ?? null;
}

/** What is true for this feature now, in the one notice slot. Nothing, or an empty list, takes it away. */
export function useNotice(notices: FrameNotice | readonly FrameNotice[] | null): void {
  const store = useInner().notices;
  const feed = useId();
  const list =
    notices === null
      ? []
      : Array.isArray(notices)
        ? (notices as readonly FrameNotice[])
        : [notices as FrameNotice];
  useEffect(() => store.post(feed, list));
  useEffect(() => () => store.post(feed, []), [store, feed]);
}

/** Today's rail, fed as a model while it is not yet built from the places' registrations. */
export function useRailModel(model: RailModel | null): void {
  const rail = useInner().rail;
  useLayoutEffect(() => rail.set(model));
  useLayoutEffect(() => () => rail.set(null), [rail]);
}

/**
 * The rail's foot, fed by what holds the account and the sync: who is signed in, Pull new mail, the quiet tools. The
 * places above it are the registrations' and are never fed. Null, or the feeder gone, takes the foot away. While a
 * shell feeds the whole rail (`useRailModel`), that model's own foot is the one drawn. The feeder hands the same
 * object while nothing of it changed: a new one draws the rail again.
 */
export function useRailFoot(foot: RailFootModel | null): void {
  const fed = useInner().foot;
  useLayoutEffect(() => fed.set(foot));
  useLayoutEffect(() => () => fed.set(null), [fed]);
}

/** The mail state ladder's reading and the browser's network, as today's views hold them. */
export function useConnectionFeed(feed: ConnectionFeed): void {
  const connection = useInner().connection;
  useLayoutEffect(() => connection.set(feed));
  /* A part that feeds it and goes takes its reading with it: no last reading stands frozen in the slot. */
  useLayoutEffect(() => () => connection.set(NO_CONNECTION), [connection]);
}

/**
 * A list's selection bar stands while `shown`. On a phone's width it stands where the dock stood: the frame draws no
 * dock while any part says so (the design's rule; the frame decides, a screen never hides the dock itself).
 */
export function useSelectionBar(shown: boolean): void {
  const bars = useInner().bars;
  const id = useId();
  useLayoutEffect(() => {
    if (!shown) return;
    bars.set([...bars.read().filter((bar) => bar !== id), id]);
    return () => bars.set(bars.read().filter((bar) => bar !== id));
  }, [bars, id, shown]);
}

/**
 * A STAGE IS OWED while `owed`: it stands over the app at whatever address, the address untouched, until this part
 * says otherwise or goes (`stage-entry.ts` has the rule). For a part that lives for the frame's life (a piece of what
 * the host stands above the panes): a pane that said it would take its word away with a walk between places. What is
 * held is the part's own word, so under another scope nothing is owed until a part there says so.
 */
export function useStageOwed(id: StageId, owed: boolean): void {
  const feed = useInner().owed;
  const part = useId();
  useLayoutEffect(() => {
    if (!owed) return;
    feed.set([...feed.read().filter((word) => word.part !== part), { part, id }]);
    return () => feed.set(feed.read().filter((word) => word.part !== part));
  }, [feed, part, id, owed]);
}

/** Whether the whole rail stands over the app: today's views read it as they read their own state. */
export function useRailOpen(): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
  return useInner().railOpen;
}

/**
 * A product's commands for the palette while the caller is mounted; they go with it. `onScreen` says whether this
 * product's place is the one on screen (its commands then come first). The feed changes only when the offers'
 * shape does; `read()` hands the newest offers, so a press runs this render's `run`, never a kept one.
 */
export function usePaletteOffers(
  source: OfferSource,
  offers: readonly PaletteOffer[],
  onScreen: boolean,
): void {
  const store = useInner().offers;
  const part = useId();
  const latest = useRef(offers);
  latest.current = offers;
  const shape = shapeOf(offers);
  useLayoutEffect(() => {
    store.post(part, { source, onScreen, shape, read: () => latest.current });
  }, [store, part, source, onScreen, shape]);
  useLayoutEffect(() => () => store.post(part, null), [store, part]);
}

/** Every product's offers now, the source on screen first, then `OFFER_SOURCES`' order. */
export function usePaletteFeeds(): readonly OfferFeed[] {
  return useSignal(useInner().offers.feeds);
}

/** The letter handed to `write`, once: a second call returns null. */
export function useLinkedDraft(): () => LinkedDraft | null {
  const draft = useInner().draft;
  return () => {
    const taken = draft.current;
    draft.current = null;
    return taken;
  };
}

/**
 * THE LETTER THAT WAS OPENED AS ENTERED (`commands.go(to, { entered: true })`), for the place that lists it: its id
 * while the address still names it, and `taken`, which the place calls once it has entered the letter's row. Null
 * for every other way in (a link, a reload, Back, a walk): those are previews.
 */
export function useEntered(): { readonly letter: string | null; readonly taken: () => void } {
  const inner = useInner();
  const asked = useSyncExternalStore(inner.entered.subscribe, inner.entered.read, inner.entered.read);
  const letter = asked !== null && asked.fragment === fragmentOf(inner.api.route) ? asked.letter : null;
  const feed = inner.entered;
  const taken = useCallback(() => {
    if (feed.read() === asked) feed.set(null);
  }, [asked, feed]);
  return useMemo(() => ({ letter, taken }), [letter, taken]);
}
