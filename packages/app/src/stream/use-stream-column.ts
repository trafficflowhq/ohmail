import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEngine } from "@ohmail/app-logic/engine";
import { useStreamNear } from "@ohmail/app-logic/lists/stream-near";
import { afterPaint } from "@ohmail/app-logic/lists/visit";
import { useStreamWindow } from "@ohmail/app-logic/lists/stream-window";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { scrollProgrammatically } from "@ohmail/app-logic/session/programmatic-scroll";
import { StreamVisits, type StreamModel } from "@ohmail/app-logic/streams";
import { onReplyPress } from "@ohmail/app-logic/writing/sent-reveal";
import type { ReaderEntry } from "../host/index.js";

export interface Clip {
  readonly phone: boolean;
  readonly whole: ReadonlySet<string>;
  readonly linked: string | null;
  /** The item opened whole (true), or shut again (false); the press on it says which. */
  readonly set: (id: string, whole: boolean) => void;
}

/** Keep the letter in place as its inline editor opens, closes or changes parent. */
export function useHoldForReply(
  model: StreamModel,
  reply: ReturnType<NonNullable<ReaderEntry["useInlineReply"]>>,
): void {
  const replyHost = reply?.messageId ?? null;
  useEffect(
    () =>
      onReplyPress((parent) => {
        if (replyHost !== null && reply?.conversations.get(replyHost)?.messages.some((m) => m.id === parent))
          model.scroll.hold(replyHost);
      }),
    [reply, replyHost, model.scroll],
  );
  const lastHost = useRef<string | null>(null);
  useLayoutEffect(() => {
    const closed = lastHost.current;
    if (closed !== null && closed !== replyHost && !reply?.conversations.has(closed))
      model.scroll.hold(closed, true);
    lastHost.current = replyHost;
  }, [replyHost, model.scroll, reply]);
}

export function useStreamViewport(model: StreamModel) {
  const root = useRef<HTMLDivElement | null>(null);
  /* The cards share the column width. Subsequent changes come from layout, never from individual cards. */
  const column = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = column.current;
    if (!model.scroller || !node) return;
    setWidth(node.offsetWidth);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [model.scroller]);
  const { attach: attachScroller } = model;
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      root.current = node;
      attachScroller(node);
    },
    [attachScroller],
  );
  const ids = useMemo(() => model.items.map((item) => item.id), [model.items]);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!model.scroller) return;
    return afterPaint(model.scroller, () => setArmed(true));
  }, [model.scroller]);
  const { start, end, opening, inFlight, padTopPx, padBottomPx, ensure } = useStreamWindow({
    armed,
    ids,
    getRoot: () => root.current,
    cardAttribute: "data-stream-window-item",
    endFlight: () => (model.read.flying() ? model.read.hands() : null),
  });
  const mounted = useMemo(() => ids.slice(start, end), [ids, start, end]);
  const openingIds = useMemo(() => ids.slice(0, opening), [ids, opening]);
  const { near, onApproach } = useStreamNear(mounted, openingIds, armed, () => root.current, inFlight);
  const mountedKey = mounted.join("\u0000");
  const { prefetch } = model;
  const engine = useEngine();
  useEffect(() => {
    const scroller = model.scroller;
    const Observer = scroller?.ownerDocument.defaultView?.IntersectionObserver;
    if (!scroller || !armed || !Observer) return;
    let active = true;
    const observer = new Observer(
      (entries) => {
        if (!active) return;
        const near: string[] = [];
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.streamItem;
          if (entry.isIntersecting && id) near.push(id);
        }
        if (near.length === 0) return;
        onApproach(near);
        if (model.place === "news") prefetch?.(near);
      },
      { root: scroller, rootMargin: "100% 0px" },
    );
    for (const card of scroller.querySelectorAll("[data-stream-item]")) observer.observe(card);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [model.scroller, model.place, armed, onApproach, prefetch, engine, mountedKey]);
  return { attach, column, width, ids, start, end, padTopPx, padBottomPx, ensure, near };
}

type Viewport = Pick<ReturnType<typeof useStreamViewport>, "ids" | "start" | "end" | "ensure">;

function useStreamPosition(model: StreamModel, { ids, start, end, ensure }: Viewport): void {
  const { scroller, place } = model;
  const positions = useContext(StreamVisits)?.positions;
  const [saved] = useState(() => (model.addressedId === null ? positions?.get(place) : undefined));
  const restoredPosition = useRef(false);
  useLayoutEffect(() => {
    if (!scroller || ids.length === 0 || restoredPosition.current) return;
    if (saved && model.addressedId === null) {
      const index = saved.id === null ? -1 : ids.indexOf(saved.id);
      if (index >= 0 && (index < start || index >= end)) {
        ensure(index);
        return;
      }
      const anchor = Array.from(scroller.querySelectorAll<HTMLElement>("[data-stream-item]")).find(
        (card) => card.dataset.streamItem === saved.id,
      );
      const top =
        anchor && saved.offset !== null
          ? scroller.scrollTop +
            anchor.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            saved.offset
          : saved.top;
      scrollProgrammatically(scroller, top);
    }
    restoredPosition.current = true;
  }, [scroller, ids, saved, model.addressedId, ensure, start, end]);
  useLayoutEffect(() => {
    if (!scroller || !positions) return;
    return () => {
      if (!restoredPosition.current) return;
      const portTop = scroller.getBoundingClientRect().top;
      const anchor =
        scroller.clientHeight > 0
          ? Array.from(scroller.querySelectorAll<HTMLElement>("[data-stream-item]")).find(
              (card) => card.getBoundingClientRect().bottom > portTop,
            )
          : undefined;
      positions.set(place, {
        top: scroller.scrollTop,
        id: anchor?.dataset.streamItem ?? null,
        offset: anchor ? anchor.getBoundingClientRect().top - portTop : null,
      });
    };
  }, [positions, place, scroller]);
}

interface Landing {
  id: string;
  entry: StreamModel["entered"] | null;
  mayExpand: boolean;
  priorToolbar: string | null;
  settled: boolean;
}

export function useStreamClips(
  model: StreamModel,
  phone: boolean,
  routeOpen: string | null,
  viewport: Viewport,
) {
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set());
  const [linkedOpen, setLinkedOpen] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [collapsedAction, setCollapsedAction] = useState<string | null>(null);
  useEffect(() => setCollapsedAction(null), [model.actionId]);
  useStreamPosition(model, viewport);
  const landed = useRef<Landing | null>(null);
  const setOne = useStableCallback((id: string, open: boolean) => {
    model.scroll.toggled(id, open);
    if (!open && model.actionId === id) setCollapsedAction(id);
    else if (open) setCollapsedAction((current) => (current === id ? null : current));
    if (landed.current?.id === id) {
      landed.current.mayExpand = false;
      setLinkedOpen((value) => (value === id ? null : value));
    }
    setWhole((was) => {
      if (was.has(id) === open) return was;
      const next = new Set(was);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  });
  const keyboardOpened = model.keyboardOpened;
  useLayoutEffect(() => {
    if (!phone && keyboardOpened !== null) setOne(keyboardOpened.id, true);
  }, [keyboardOpened, phone, setOne]);
  const openId = model.addressedId;
  const clip: Clip = { phone, whole, linked: linkedOpen === openId ? linkedOpen : null, set: setOne };
  const openAt = openId === null ? -1 : model.items.findIndex((m) => m.id === openId);

  useStreamLanding({
    model,
    phone,
    routeOpen,
    viewport,
    openAt,
    openId,
    landed,
    linkedOpen,
    whole,
    setOne,
    setWhole,
    setLinkedOpen,
    setRestored,
  });
  return { clip, keyboardOpened, restored, whole, collapsedAction };
}

function useStreamLanding({
  model,
  phone,
  routeOpen,
  viewport,
  openAt,
  openId,
  landed,
  linkedOpen,
  whole,
  setOne,
  setWhole,
  setLinkedOpen,
  setRestored,
}: {
  model: StreamModel;
  phone: boolean;
  routeOpen: string | null;
  viewport: Viewport;
  openAt: number;
  openId: string | null;
  landed: RefObject<Landing | null>;
  linkedOpen: string | null;
  whole: ReadonlySet<string>;
  setOne: Clip["set"];
  setWhole: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setLinkedOpen: Dispatch<SetStateAction<string | null>>;
  setRestored: Dispatch<SetStateAction<string | null>>;
}): void {
  const { start, end, ensure } = viewport;
  /*
   * Land the addressed card once per opening. Links and Search hits expand it. A local cursor step keeps its fold.
   * Only the explicit Search entry gives this landing permission to read.
   */
  const { scroll, entered: entry, read, openedLocally, toolbar } = model;
  useEffect(() => {
    if (openAt < 0 || openId === null) {
      const previous = landed.current;
      const prior = previous?.priorToolbar ?? null;
      if (
        routeOpen === null &&
        previous?.settled &&
        prior !== null &&
        whole.has(prior) &&
        scroll.onScreen(prior)
      ) {
        setOne(previous.id, false);
        setRestored(prior);
      }
      landed.current = null;
      setLinkedOpen(null);
      return;
    }
    if (model.scroller === null) return;
    const request = !phone && entry?.letter === openId ? entry : null;
    if (landed.current?.id === openId && (!request || landed.current.entry === request)) return;
    if (openAt < start || openAt >= end) {
      ensure(openAt);
      return;
    }
    const local = openedLocally(openId);
    if (local && linkedOpen !== null && linkedOpen !== openId) {
      setWhole((was) => new Set(was).add(linkedOpen));
    }
    const mayExpand = !phone && (request !== null || !local);
    const prior = toolbar.current;
    const priorToolbar =
      model.place === "news" &&
      !phone &&
      !local &&
      !request &&
      prior !== null &&
      prior !== openId &&
      whole.has(prior)
        ? prior
        : null;
    const flight = { id: openId, entry: request, mayExpand, priorToolbar, settled: false };
    setRestored(null);
    landed.current = flight;
    setLinkedOpen(null);
    if (request) {
      read.enter(openId);
      request.taken();
    }
    scroll.scrollTo(
      openId,
      mayExpand
        ? () => {
            if (landed.current !== flight) return;
            flight.settled = true;
            if (flight.mayExpand) setLinkedOpen(openId);
          }
        : undefined,
    );
  }, [
    landed,
    setLinkedOpen,
    setRestored,
    setWhole,
    openAt,
    start,
    end,
    openId,
    model.scroller,
    scroll,
    entry,
    phone,
    read,
    openedLocally,
    linkedOpen,
    ensure,
    routeOpen,
    whole,
    toolbar,
    setOne,
    model.place,
  ]);
}
