/**
 * WHAT A FEATURE REACHES OF THE FRAME, and nothing else: the frame's api (its host, the route, the plan, the
 * named commands, the report), one notice feed of its own, and the report slot. Today's views also feed the
 * rail's model and the connection's readings, until their own places register.
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ToastFn } from "@ohmail/app-logic/press/report";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";
import type { LinkedDraft } from "../host/index.js";
import type { FrameApi, FrameNotice, RailModel } from "./contract.js";
import type { Feed } from "./feeds.js";
import type { NoticeStore } from "./notice-store.js";

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

export interface FrameInner {
  readonly api: FrameApi;
  readonly notices: NoticeStore;
  readonly rail: Feed<RailModel | null>;
  readonly connection: Feed<ConnectionFeed>;
  /** A letter handed to `write`, taken once by the place that writes. */
  readonly draft: { current: LinkedDraft | null };
  /** Whether the whole rail stands over the app, and its setter (`commands.rail` is the same setter). */
  readonly railOpen: readonly [boolean, Dispatch<SetStateAction<boolean>>];
  /** The parts whose selection's bar stands now, by their own id. */
  readonly bars: Feed<readonly string[]>;
}

export const FrameContext = createContext<FrameInner | null>(null);

function useInner(): FrameInner {
  const inner = useContext(FrameContext);
  if (!inner) throw new Error("a part of the frame was drawn outside the frame");
  return inner;
}

export function useFrame(): FrameApi {
  return useInner().api;
}

/** The report slot: the press seam's report function, so Undo reaches it unchanged. */
export function useReport(): ToastFn {
  return useInner().api.report;
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

/** Whether the whole rail stands over the app: today's views read it as they read their own state. */
export function useRailOpen(): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
  return useInner().railOpen;
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
