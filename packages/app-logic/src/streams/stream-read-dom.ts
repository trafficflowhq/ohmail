"use client";

/**
 * THE READ RULE ON A STREAM'S SCROLLER. Listens on the stream's own scroller only (a wheel over the list beside it is
 * no hand), measures the mounted items, asks the rule and writes what it answers. A scroll that no hand made (a row's
 * press, `j`/`k`, a landing) reads nothing by itself; the rest after it may. A jump to an end (End, Home, Ctrl or Cmd
 * with an arrow) is a flight, not a hand: what it carries past is never read. A hidden tab reads nothing.
 */
import { measureStream, bottomOf } from "./stream-measure.js";
export { measureStream, streamReadView } from "./stream-measure.js";
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { documentHidden } from "../session/document-hidden.js";
import {
  STREAM_REST_MS,
  createStreamReadRule,
  type StreamHand,
  type StreamLook,
  type StreamReadRule,
} from "./read-rule.js";
import type { StreamLeaveState } from "./leave.js";
import {
  STREAM_LANDING_QUIET_MS,
  listenStreamControls,
  ownStreamScroll,
  streamScrollJudgement,
  watchStreamContent,
} from "./stream-scroll-input.js";

export { STREAM_LANDING_QUIET_MS } from "./stream-scroll-input.js";

/** What the stream's model knows of an item: whether it is unread and whether its body is in. */
export interface StreamItemFacts {
  readonly unread: boolean;
  readonly ready: boolean;
}

export interface StreamReadDomOptions {
  /** The stream's own scroller, once it is mounted. */
  readonly scroller: HTMLElement | null;
  readonly receipts?: boolean;
  /** The stream's order, top to bottom. */
  readonly order: readonly string[];
  /** The selected card of this visit, where the stream has one. */
  readonly openId?: string | null;
  /** The selected card once its body can be read. */
  readonly readyId?: string | null;
  readonly factsOf: (id: string) => StreamItemFacts | null;
  /** Write these ids read now. */
  readonly write: (ids: readonly string[]) => void;
  /** A jump to an end has rested: the scroller stood still STREAM_LANDING_QUIET_MS after its key. */
  readonly onLanded?: () => void;
  readonly onJudged?: () => void;
  readonly readingBlocked?: () => boolean;
  /** The clock; the page's by default. */
  readonly now?: () => number;
}

export interface StreamReadDom {
  /** A press in the stream or on a row, an arrow, `j` or `k`. */
  enter(letter?: string, viewport?: boolean): void;
  /** Stop a pending dwell or end flight when the address becomes a preview. */
  preview(): void;
  /** The app moved the stream: its scroll is no hand's, and it drives nothing. */
  moved(): void;
  windowChanged(): void;
  settled(): void;
  own(scroll: () => void): void;
  hands(): number;
  keepUnread(id: string): void;
  /** What the leave commits from. */
  leaveState(): StreamLeaveState;
  /** A jump to an end is in flight: from its key until the scroller has rested. */
  flying(): boolean;
  judging(): boolean;
  readonly rule: StreamReadRule;
}

function flightOf(flag: { current: boolean }, landed: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      flag.current = false;
      landed();
    }, STREAM_LANDING_QUIET_MS);
  };
  return {
    start(): void {
      flag.current = true;
      arm();
    },
    moved(): void {
      if (flag.current) arm();
    },
    stop(): void {
      clearTimeout(timer);
      flag.current = false;
    },
  };
}

/** Run the pending-body clock only while the viewport can be attended. */
function watchPreviewDwell(
  doc: Document,
  measure: () => StreamLook,
  now: () => number,
  rule: StreamReadRule,
  flying: () => boolean,
  write: (ids: readonly string[]) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attended = (): boolean => !documentHidden() && doc.hasFocus() && !flying();
  const clear = (): void => {
    clearTimeout(timer);
    rule.previewDwell(null);
  };
  const arm = (): void => {
    clearTimeout(timer);
    const due = rule.previewDue;
    if (due === null) return;
    timer = setTimeout(
      () => {
        write(rule.previewDwell(attended() ? measure() : null));
        arm();
      },
      Math.max(1, Math.ceil(due - now())),
    );
  };
  const visibility = (): void => {
    if (!attended()) clear();
  };
  doc.addEventListener("visibilitychange", visibility);
  doc.defaultView?.addEventListener("blur", clear);
  return {
    attended,
    observe(look: StreamLook): void {
      write(rule.previewDwell(attended() ? look : null));
      arm();
    },
    clear,
    stop(): void {
      clear();
      doc.removeEventListener("visibilitychange", visibility);
      doc.defaultView?.removeEventListener("blur", clear);
    },
  };
}

export function useStreamRead(o: StreamReadDomOptions): StreamReadDom {
  const ruleRef = useRef<StreamReadRule | null>(null);
  ruleRef.current ??= createStreamReadRule(o.receipts);
  const rule = ruleRef.current;
  const opts = useRef(o);
  opts.current = o;
  const bottomRef = useRef<string | null>(null);
  useEffect(() => {
    if (o.openId !== undefined) rule.selectionChanged(o.openId);
  }, [o.openId, rule]);
  const arm = useRef<(() => void) | null>(null);
  const refresh = useRef<((settled?: boolean) => void) | null>(null);
  const ownScroll = useRef<((scroll: () => void) => void) | null>(null);
  const cancelPending = useRef<(() => void) | null>(null);
  const flyingRef = useRef(false);
  const judgingRef = useRef(false);
  const appMovedAt = useRef(Number.NEGATIVE_INFINITY);
  const handCount = useRef(0);
  const now = (): number => (opts.current.now ?? (() => performance.now()))();

  useEffect(() => {
    if (!o.scroller) return;
    return bindReadScroller(o.scroller, rule, now, {
      opts,
      bottomRef,
      arm,
      refresh,
      ownScroll,
      cancelPending,
      flyingRef,
      judgingRef,
      appMovedAt,
      handCount,
    });
    /* The options are read through the ref; a new scroller is listened on afresh. */
  }, [o.scroller, rule]);

  useEffect(() => {
    // A newly loaded body starts the full dwell for the letter the person chose.
    if (o.readyId && rule.holdsEntered(o.readyId)) arm.current?.();
  }, [o.readyId, o.scroller, rule]);

  const windowChanged = useCallback(() => refresh.current?.(), []);
  const settled = useCallback(() => refresh.current?.(true), []);
  const own = useCallback((scroll: () => void) => {
    if (ownScroll.current) ownScroll.current(scroll);
    else scroll();
  }, []);
  const enter = useCallback(
    (letter?: string, viewport?: boolean) => {
      rule.enter(now(), letter, viewport);
      arm.current?.();
    },
    [rule],
  );
  const moved = useCallback(() => {
    appMovedAt.current = now();
    rule.appMoved(appMovedAt.current);
  }, [rule]);
  const preview = useCallback(() => {
    cancelPending.current?.();
    rule.preview();
  }, [rule]);
  const keepUnread = useCallback((id: string) => rule.keepUnread(id), [rule]);
  const leaveState = useCallback((): StreamLeaveState => {
    const newest = opts.current.order.find((id) => rule.shown(id)) ?? null;
    return {
      drove: rule.handDrove,
      newestSeenId: newest,
      bottomVisibleId: bottomRef.current,
      read: (id) => rule.read(id),
    };
  }, [rule]);
  const flying = useCallback(() => flyingRef.current, []);
  const hands = useCallback(() => handCount.current, []);
  const judging = useCallback(() => judgingRef.current, []);
  return {
    enter,
    preview,
    moved,
    windowChanged,
    settled,
    own,
    hands,
    keepUnread,
    leaveState,
    flying,
    judging,
    rule,
  };
}

export interface StreamReadRefs {
  opts: RefObject<StreamReadDomOptions>;
  bottomRef: RefObject<string | null>;
  arm: RefObject<(() => void) | null>;
  refresh: RefObject<((settled?: boolean) => void) | null>;
  ownScroll: RefObject<((scroll: () => void) => void) | null>;
  cancelPending: RefObject<(() => void) | null>;
  flyingRef: RefObject<boolean>;
  judgingRef: RefObject<boolean>;
  appMovedAt: RefObject<number>;
  handCount: RefObject<number>;
}

function bindReadScroller(
  el: HTMLElement,
  rule: StreamReadRule,
  now: () => number,
  refs: StreamReadRefs,
): () => void {
  const { opts, bottomRef, arm, refresh, ownScroll, cancelPending, flyingRef, judgingRef } = refs;
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  const measure = (at = now()): StreamLook => measureStream(el, opts.current.factsOf, at);
  const write = (ids: readonly string[]): void => {
    if (ids.length > 0) opts.current.write(ids);
  };
  const unstable = () => opts.current.readingBlocked?.() === true;
  const blocked = () => flyingRef.current || unstable();
  const pending = watchPreviewDwell(el.ownerDocument, measure, now, rule, blocked, write);
  const receiptAttended = () => opts.current.receipts && pending.attended();
  let lastScroll: StreamLook | null = null;
  const flight = flightOf(flyingRef, () => {
    opts.current.onLanded?.();
    if (blocked()) return;
    const settled = measure();
    if (lastScroll && lastScroll.scrollTop === settled.scrollTop) pending.observe(lastScroll);
    rule.settled(settled);
    pending.observe(settled);
  });
  const rest = (): void => {
    if (documentHidden() || blocked()) return;
    const l = measure();
    bottomRef.current = bottomOf(l);
    write(rule.rest(l, null, opts.current.openId));
  };
  const armRest = (): void => {
    clearTimeout(restTimer);
    restTimer = setTimeout(rest, STREAM_REST_MS);
  };
  const observe = () => !blocked() && pending.observe(measure());
  arm.current = () => {
    armRest();
    observe();
  };
  const judgement = streamScrollJudgement(el, rule, now, refs);
  cancelPending.current = () => {
    judgement.cancel();
    clearTimeout(restTimer);
    pending.clear();
    flight.stop();
    lastScroll = null;
    bottomRef.current = null;
  };
  const scrollOwnership = ownStreamScroll(el);
  ownScroll.current = scrollOwnership.run;
  const onScroll = (): void => {
    const own = scrollOwnership.heard();
    if (!own) flight.moved();
    const l = measure();
    if (!own && !blocked()) judgement.scroll(l.at, controls.isolatedLetterFocused);
    if (!own) lastScroll = unstable() ? null : l;
    const inFlight = blocked();
    if (inFlight && !flyingRef.current) {
      rule.look(l, false, true);
      pending.clear();
      return;
    }
    bottomRef.current = bottomOf(l);
    const attended = !documentHidden();
    write(rule.look(l, attended, own || inFlight || judgingRef.current, receiptAttended()));
    pending.observe(l);
    armRest();
  };
  refresh.current = (settled) => {
    if (blocked()) return;
    const l = measure();
    if (settled) rule.settled(l);
    bottomRef.current = bottomOf(l);
    pending.observe(l);
    if (settled) armRest();
  };
  const still = (by: StreamHand): void => {
    if (documentHidden() || blocked()) return;
    const l = measure();
    write(rule.still(l, by));
    pending.observe(l);
    armRest();
  };
  const onWheel = (e: WheelEvent): void => {
    if (e.deltaY === 0) return;
    judgement.hand();
    rule.hand("wheel", now());
    still("wheel");
  };
  const stopWatching = watchStreamContent(el, rule, observe);
  const controls = listenStreamControls(el, rule, now, {
    onScroll,
    onWheel,
    still,
    hand: judgement.hand,
    onEnd: () => {
      lastScroll = null;
      pending.clear();
      flight.start();
    },
    onEnter: () => {
      rule.enter(now());
      observe();
    },
  });
  seedStreamLook(measure(), rule, bottomRef, receiptAttended);
  return () => {
    arm.current = null;
    refresh.current = null;
    ownScroll.current = null;
    cancelPending.current = null;
    clearTimeout(restTimer);
    judgement.cancel();
    pending.stop();
    flight.stop();
    stopWatching();
    controls.stop();
  };
}

/** Record what was already visible on opening without judging it as read. */
function seedStreamLook(
  first: StreamLook,
  rule: StreamReadRule,
  bottomRef: StreamReadRefs["bottomRef"],
  attended: () => boolean | undefined,
): void {
  bottomRef.current = bottomOf(first);
  rule.look(first, !documentHidden(), false, attended());
}
