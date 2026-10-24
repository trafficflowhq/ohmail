"use client";

/**
 * THE CONVERSATION'S SQUARES, beside its panels — one per message in panel order (oldest first):
 * solid accent while unread, the same square dimmed once read, hollow for the account's own. A
 * square never carries a count or text; its name says which message it is and its state. A
 * vertical toolbar with one tab stop (roving); ↑/↓, Home and End move along it. In the split view it
 * stands BESIDE the reading column, never in it: a box inserted just before the column, laid over the
 * column's own left padding (one tile gap, the 18px rail, one tile gap to the paper), so it never
 * covers a panel and nothing the scroll does can move it. (Sticky inside the scroller, WebKitGTK
 * repositioned it apart from the scroll: for a frame it rode with the panels and snapped back.) A
 * wheel over it scrolls the conversation, as it did when it stood inside. In the reader sheet it
 * stays sticky in the conversation's left padding: the sheet is no split view to stand it in.
 *
 * THE WALK (`threadWalk`, client-engine): the ring (display only) stands on the LAST message whose
 * top has crossed a reading line 30 % down the reading view, the line sliding at both ends so the
 * first is current at the top and the last at the very end. The geometry is measured once per layout
 * change (a frame after a resize of the conversation or the scroller, the window, the fonts, the
 * messages); a scroll reads only the offset. A press or Enter puts that message's top on the line,
 * holds the ring there until the person's own scroll (an app scroll is stamped and keeps it) and
 * enters the visit. Opening a conversation holds the opened message the same way. The walk is
 * published on the visit's channel (`thread-walk-channel.ts`), so the list row's strip wears the same
 * ring and its press is this jump.
 */
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { isOwnOutbound, threadWalk, type EngineMessage, type Walk } from "@ohmail/client-engine";
import { cssRect } from "@ohmail/ui";
import { clockOf, displayTime, metaLine, senderName } from "./format";
import { scrollByHand, scrollProgrammatically, stampLive } from "./programmatic-scroll";
import { nextFrame, viewOf } from "./reader-seen";
import type { ThreadWalkChannel } from "./thread-walk-channel";

/** Below this width the conversation keeps its panels wide and the column takes the thin form. */
const NARROW_PX = 560;

/** The roving keys of a row (`x`) or column (`y`) of squares: they move the tab stop, never the reader. */
export function marksKeys(axis: "x" | "y", onStop: (id: string) => void) {
  const [back, on] = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".tm-mb")];
    const i = all.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    // Enter and Space press the focused square; in a list row they must not reach the list's keys too.
    if (axis === "x" && (e.key === "Enter" || e.key === " ")) {
      e.stopPropagation();
      return;
    }
    let j = i;
    if (e.key === on) j = Math.min(all.length - 1, i + 1);
    else if (e.key === back) j = Math.max(0, i - 1);
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = all.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    onStop(all[j]!.dataset.for!);
    all[j]!.focus({ preventScroll: true });
  };
  return onKey;
}

export function ThreadMarks({
  messages,
  scroller,
  conv,
  onEnter,
  openedId,
  walk: channel,
  releaseAnchor,
}: {
  /** The panels' messages in panel order, the opened one as the pane presents it. */
  messages: readonly EngineMessage[];
  scroller?: RefObject<HTMLElement | null>;
  /** The conversation's wrapper, whose width picks the thin form. */
  conv?: RefObject<HTMLElement | null>;
  onEnter: () => void;
  /** The message the reader opened: held current on arrival, and current in a thread that fits its view. */
  openedId?: string;
  /** The visit's channel: where the ring is published and the list row's press comes in. */
  walk?: ThreadWalkChannel;
  /** Ends the pane's open anchor, so a press is not undone by the next body landing. */
  releaseAnchor?: () => void;
}) {
  const [sc, setSc] = useState<HTMLElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [here, setHere] = useState<string | null>(null);
  const [stop, setStop] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [shown, setShown] = useState(true);
  /** Is the reader laid out (a reading height above zero)? A column hidden at a phone width is not. */
  const [live, setLive] = useState(false);
  const ids = messages.map((m) => m.id).join(" ");
  const list = useRef<string[]>([]);
  list.current = ids === "" ? [] : ids.split(" ");
  const opened = useRef(openedId ?? null);
  opened.current = openedId ?? null;
  const walk = useRef<Walk | null>(null);
  const view = useRef(0);
  /** The held square: the opened message on arrival, a pressed one after a press; a hand scroll ends it. */
  const pin = useRef<string | null>(openedId ?? null);
  const bar = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ onEnter, releaseAnchor, channel });
  latest.current = { onEnter, releaseAnchor, channel };

  /* The scroller element. Mounted in one commit with it, this layout effect runs before its ref
     is attached; the passive one runs after. */
  useLayoutEffect(() => setSc(scroller?.current ?? null));
  useEffect(() => setSc(scroller?.current ?? null));
  const beside = sc?.matches(".view.split > .read-col") ?? false;

  /* The column's box, the split column's sibling. */
  useLayoutEffect(() => {
    if (!sc?.parentElement || !beside) return;
    const box = sc.ownerDocument.createElement("div");
    box.className = "thread-marks";
    sc.parentElement.insertBefore(box, sc);
    setHost(box);
    return () => { box.remove(); setHost(null); };
  }, [sc, beside]);
  useLayoutEffect(() => {
    if (!host) return;
    host.toggleAttribute("data-narrow", narrow);
    host.hidden = !shown;
  }, [host, narrow, shown]);

  /* The landing: a conversation opened (or opened on another message) holds that message. */
  useLayoutEffect(() => { pin.current = openedId ?? null; }, [openedId]);

  /** The ring for the scroll as it stands: the held square, else the walk's answer (−1 keeps the last). */
  const look = useCallback((): void => {
    const el = scroller?.current;
    const w = walk.current;
    if (!el || !w) return;
    const at = pin.current === null ? -1 : list.current.indexOf(pin.current);
    const i = w.current(el.scrollTop, at >= 0 ? { index: at } : null);
    if (i >= 0) setHere(list.current[i] ?? null);
  }, [scroller]);

  /** Put message `i`'s top on the reading line and hold it there. */
  const land = useCallback((i: number): void => {
    const el = scroller?.current;
    const w = walk.current;
    const id = list.current[i];
    if (!el || !w || id === undefined) return;
    latest.current.releaseAnchor?.();
    scrollProgrammatically(el, w.scrollFor(i));
    pin.current = id;
    setStop(id);
  }, [scroller]);

  /** The geometry, in one pass: the panels' tops in the content, the scroll's range, the reading height. */
  const measure = useCallback((): void => {
    const el = scroller?.current;
    if (!el) return;
    const top0 = cssRect(el).top;
    const at = new Map<string, number>();
    for (const p of el.querySelectorAll<HTMLElement>("[data-conv-id]")) at.set(p.dataset.convId ?? "", cssRect(p).top - top0 + el.scrollTop);
    const v = viewOf(el);
    view.current = Math.max(0, v.bottom - v.top);
    walk.current = threadWalk({
      tops: list.current.map((id) => at.get(id) ?? Number.NaN),
      max: Math.max(0, el.scrollHeight - el.clientHeight),
      view: view.current,
      opened: opened.current === null ? -1 : list.current.indexOf(opened.current),
    });
    setLive(view.current > 0);
    // A press on the list row while no reader was on screen: this reader lands on it.
    const ch = latest.current.channel;
    const owed = ch?.pending ?? null;
    if (owed !== null && view.current > 0) {
      const i = list.current.indexOf(owed);
      if (i >= 0) {
        ch!.pending = null;
        land(i);
      }
    }
    look();
  }, [scroller, look, land]);

  /* Measured once per layout change, a frame after it; a scroll reads only the offset. */
  useEffect(() => {
    const el = scroller?.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView ?? window;
    let measuring: (() => void) | null = null;
    let looking: (() => void) | null = null;
    const soon = (): void => { if (!measuring) measuring = nextFrame(win, () => { measuring = null; measure(); }); };
    const onScroll = (): void => {
      // The person's own scroll ends the hold; the app's (stamped) keeps it.
      if (pin.current !== null && !stampLive(el)) pin.current = null;
      if (!looking) looking = nextFrame(win, () => { looking = null; look(); });
    };
    measure();
    soon();
    el.addEventListener("scroll", onScroll, { passive: true });
    win.addEventListener("resize", soon);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
    ro?.observe(el);
    if (conv?.current) ro?.observe(conv.current);
    let gone = false;
    el.ownerDocument.fonts?.ready.then(() => { if (!gone) soon(); }, () => {});
    return () => {
      gone = true;
      measuring?.();
      looking?.();
      ro?.disconnect();
      el.removeEventListener("scroll", onScroll);
      win.removeEventListener("resize", soon);
    };
  }, [scroller, conv, ids, measure, look]);

  /* The thin form, by the conversation's own width rather than the window's; none while the
     column is not laid out (a phone width hides it). */
  useEffect(() => {
    const el = conv?.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = cssRect(el).width;
      setNarrow(w < NARROW_PX);
      setShown(w > 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [conv]);

  /* A column longer than its box keeps the ring's square in it (the app's scroll, stamped). */
  useLayoutEffect(() => {
    const b = bar.current;
    if (!b || here === null || b.scrollHeight <= b.clientHeight) return;
    const q = b.querySelector<HTMLElement>(`.tm-mb[data-for="${CSS.escape(here)}"]`);
    if (!q) return;
    if (q.offsetTop < b.scrollTop) scrollProgrammatically(b, q.offsetTop);
    else if (q.offsetTop + q.offsetHeight > b.scrollTop + b.clientHeight) scrollProgrammatically(b, q.offsetTop + q.offsetHeight - b.clientHeight);
  }, [here, host]);

  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    const sc = scroller?.current;
    const bar = e.currentTarget;
    if (!sc || e.ctrlKey) return;
    const dy = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? sc.clientHeight : 1);
    if (dy === 0) return;
    // A column longer than its box scrolls itself first.
    if (dy < 0 ? bar.scrollTop > 0 : bar.scrollTop + bar.clientHeight < bar.scrollHeight - 1) return;
    scrollByHand(sc, dy, { deltaY: e.deltaY, deltaMode: e.deltaMode });
  };

  /** A press on a square, here or in the list row: false while this reader is not laid out. */
  const jump = (id: string): boolean => {
    measure();
    const i = list.current.indexOf(id);
    if (view.current <= 0 || !walk.current || i < 0) return false;
    land(i);
    look();
    latest.current.onEnter();
    return true;
  };
  const jumpRef = useRef(jump);
  jumpRef.current = jump;

  /* The channel: this reader's ring, and its jump for the list row's press — only while laid out
     (the column a phone width hides stays mounted under the sheet, and must not answer for it). */
  const kinds = messages.map((m) => `${m.id}:${m.unread ? 1 : 0}`).join(" ");
  const shownHere = here !== null && list.current.includes(here) ? here : null;
  useEffect(() => {
    if (!live || !channel) return;
    channel.publish({ messages, here: shownHere, openedId: openedId ?? null });
    // `messages` is a fresh array each render; `kinds` is what of it the squares draw.
  }, [live, channel, kinds, shownHere, openedId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!live || !channel) return;
    return channel.bindJump((id) => jumpRef.current(id));
  }, [live, channel]);

  const tabStop = stop !== null && list.current.includes(stop) ? stop : here ?? messages[messages.length - 1]?.id ?? null;
  const onKey = marksKeys("y", setStop);
  const onJump = (id: string): void => { jump(id); };

  if (sc && !beside) {
    return (
      <div className="thread-marks" data-narrow={narrow ? "" : undefined} hidden={!shown}>
        <ThreadMarksBar messages={messages} here={here} tabStop={tabStop} onJump={onJump} onKey={onKey} barRef={bar} place="right" tipOn="focus" />
      </div>
    );
  }
  if (!host) return null;
  return createPortal(
    <ThreadMarksBar messages={messages} here={here} tabStop={tabStop} onJump={onJump} onKey={onKey} onWheel={onWheel} barRef={bar} />,
    host,
  );
}

/** Where a square's chip stands: left of the rail, right of the sheet's bar, under the row's strip. */
export type TipPlace = "left" | "right" | "under";
type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
/** The chip's right edge before the rail (left), its gap to the sheet's bar (right), under the strip's button (under). */
export const TIP_GAP = { left: 6, right: 6, under: 4 } as const;

/**
 * WHERE THE CHIP STANDS (in CSS px, the fixed box's left/top before its own translate): `left`, its
 * right edge 6px before the rail (the rail is `railW` wide, centred on the square) at the button's
 * middle — over the list's gap and the open row's end, never over message text; `right`, 6px after
 * the sheet's bar; `under`, 4px under the strip's button from the square's left less 4, kept 8px
 * inside `clamp` (the list column).
 */
export function tipAt(place: TipPlace, button: Rect, square: Rect, railW: number, chipW: number, clamp?: Rect): { left: number; top: number } {
  const middle = button.top + button.height / 2;
  if (place === "left") return { left: square.left + square.width / 2 - railW / 2 - TIP_GAP.left, top: middle };
  if (place === "right") return { left: button.right + TIP_GAP.right, top: middle };
  const lo = (clamp?.left ?? 0) + 8;
  const hi = clamp ? clamp.right - 8 - chipW : Number.POSITIVE_INFINITY;
  return { left: Math.max(lo, Math.min(square.left - 4, hi)), top: button.bottom + TIP_GAP.under };
}

/** The chip's words: who sent the square's message, and when, as its panel says it, with the clock. */
export function tipStamp(m: EngineMessage, now: Date): string {
  const when = displayTime(m, now);
  const clock = m.date ? clockOf(m.date) : "";
  return clock !== "" && when.includes(clock) ? when : metaLine(when, clock);
}

/** The chip itself: one line, the sender bold, the stamp quieter. Never a name for assistive tech (the square's own label is). */
export const ThreadTip = forwardRef<HTMLDivElement, { m: EngineMessage; place: TipPlace; now?: Date }>(function ThreadTip({ m, place, now }, ref) {
  const stamp = tipStamp(m, now ?? new Date());
  return (
    <div ref={ref} className="tm-tip" data-place={place} aria-hidden="true">
      <b>{senderName(m)}</b>
      {stamp === "" ? null : <span>{` · ${stamp}`}</span>}
    </div>
  );
});

/** Is `el` focused from the keyboard? A click's focus is not (the pointer's hover names it then). */
const keyboardFocus = (el: Element): boolean => {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
};

/**
 * The toolbar itself, drawn into the column's box. A square the pointer rests on, or that keyboard
 * focus holds, names its message in a CHIP (o9): the sender and the stamp, in one fixed element in
 * the body (the column and the list clip their overflow), placed by `tipAt`. The squares carry no
 * `title`, so the name is never shown twice. `tipOn="focus"`: only keyboard focus shows it (the
 * reader sheet, under a finger).
 */
export function ThreadMarksBar({
  messages,
  here,
  tabStop,
  onJump,
  onKey,
  onWheel,
  axis = "y",
  barRef,
  place = axis === "x" ? "under" : "left",
  tipOn = "hover",
}: {
  messages: readonly EngineMessage[];
  here: string | null;
  tabStop: string | null;
  onJump: (id: string) => void;
  onKey?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onWheel?: (e: WheelEvent<HTMLDivElement>) => void;
  /** `y`: the column beside the reader; `x`: the strip under the conversation's list row. */
  axis?: "x" | "y";
  barRef?: RefObject<HTMLDivElement | null>;
  place?: TipPlace;
  tipOn?: "hover" | "focus";
}) {
  const tm = useTranslations("message");
  const n = messages.length;
  const own = useRef<HTMLDivElement | null>(null);
  const setBar = (el: HTMLDivElement | null): void => {
    own.current = el;
    if (barRef) (barRef as { current: HTMLDivElement | null }).current = el;
  };
  const chip = useRef<HTMLDivElement | null>(null);
  const pointed = useRef<HTMLElement | null>(null);
  const focused = useRef<HTMLElement | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const named = tip === null ? null : messages.find((m) => m.id === tip) ?? null;

  /** The square the chip names: the one under the pointer, else the one keyboard focus holds. */
  const refresh = (): void => {
    const b = [pointed.current, focused.current].find((el) => el?.isConnected) ?? null;
    setTip(b?.dataset.for ?? null);
  };
  const squareOf = (t: EventTarget | null): HTMLElement | null =>
    t instanceof Element ? t.closest<HTMLElement>(".tm-mb") : null;
  /** Stand the chip by its square, where the square is now. */
  const stand = useCallback((): void => {
    const c = chip.current;
    const b = own.current;
    if (!c || !b || tip === null) return;
    const q = [...b.querySelectorAll<HTMLElement>(".tm-mb")].find((el) => el.dataset.for === tip);
    const sq = q?.querySelector(".tm-sq");
    if (!q || !sq) return;
    const railW = parseFloat(getComputedStyle(b).getPropertyValue("--tm-rail")) || 18;
    const clampTo = b.closest(".list-col");
    const at = tipAt(place, cssRect(q), cssRect(sq), railW, c.offsetWidth, clampTo ? cssRect(clampTo) : undefined);
    c.style.left = `${at.left.toFixed(1)}px`;
    c.style.top = `${at.top.toFixed(1)}px`;
  }, [tip, place]);
  useLayoutEffect(stand, [stand, named]);
  /* Standing while anything scrolls under it (the list, the strip, the column's own overflow). */
  useEffect(() => {
    if (tip === null) return;
    const win = own.current?.ownerDocument.defaultView;
    if (!win) return;
    win.addEventListener("scroll", stand, { capture: true, passive: true });
    win.addEventListener("resize", stand);
    return () => {
      win.removeEventListener("scroll", stand, { capture: true });
      win.removeEventListener("resize", stand);
    };
  }, [tip, stand]);

  return (
    <div
      ref={setBar}
      className={axis === "x" ? "tm-strip" : "tm-bar"}
      role="toolbar"
      aria-orientation={axis === "x" ? "horizontal" : "vertical"}
      aria-label={tm("marksAria")}
      onKeyDown={onKey}
      onWheel={onWheel}
      onPointerOver={tipOn === "hover" ? (e) => { pointed.current = squareOf(e.target); refresh(); } : undefined}
      onPointerOut={tipOn === "hover" ? (e) => {
        const b = squareOf(e.target);
        if (b && !(e.relatedTarget instanceof Node && b.contains(e.relatedTarget))) pointed.current = null;
        refresh();
      } : undefined}
      onFocus={(e) => {
        const b = squareOf(e.target);
        focused.current = b && keyboardFocus(b) ? b : null;
        refresh();
      }}
      onBlur={() => { focused.current = null; refresh(); }}
    >
      {messages.map((m, i) => {
        const kind = m.unread ? "unread" : isOwnOutbound(m) ? "mine" : "read";
        const label = kind === "mine"
          ? tm("markMine", { position: i + 1, count: n })
          : tm(kind === "unread" ? "markFromUnread" : "markFromRead", { position: i + 1, count: n, sender: senderName(m) });
        return (
          <button
            key={m.id}
            type="button"
            className="tm-mb"
            data-for={m.id}
            tabIndex={m.id === tabStop ? 0 : -1}
            aria-label={label}
            aria-current={m.id === here ? "location" : undefined}
            onClick={() => onJump(m.id)}
          >
            <i className={`tm-sq ${kind}`} aria-hidden="true" />
          </button>
        );
      })}
      {named && own.current ? createPortal(<ThreadTip ref={chip} m={named} place={place} />, own.current.ownerDocument.body) : null}
    </div>
  );
}
