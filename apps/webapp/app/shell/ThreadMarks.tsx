"use client";

/**
 * THE CONVERSATION'S SQUARES, beside its panels — one per message in panel order (oldest first):
 * solid accent while unread, the same square dimmed once read, hollow for the account's own. A
 * square never carries a count or text; its name says which message it is and its state. The
 * panel most in view gets a neutral ring (display only). A press or Enter brings that message's
 * panel to the top and enters the visit. A vertical toolbar with one tab stop (roving); ↑/↓, Home
 * and End move along it. In the split view it stands BESIDE the reading column, never in it: a box
 * inserted just before the column, laid over the column's own left padding, so it never covers a
 * panel and nothing the scroll does can move it. (Sticky inside the scroller, WebKitGTK
 * repositioned it apart from the scroll: for a frame it rode with the panels and snapped back.) A
 * wheel over it scrolls the conversation, as it did when it stood inside. In the reader sheet it
 * stays sticky in the conversation's left padding: the sheet is no split view to stand it in.
 */
import { useEffect, useLayoutEffect, useState, type KeyboardEvent, type RefObject, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { isOwnOutbound, type EngineMessage } from "@ohmail/client-engine";
import { cssRect } from "@ohmail/ui";
import { senderName } from "./format";
import { scrollByHand, scrollIntoViewProgrammatically } from "./programmatic-scroll";
import { nextFrame, viewOf } from "./reader-seen";

/** Below this width the conversation keeps its panels wide and the column takes the thin form. */
const NARROW_PX = 560;

export function ThreadMarks({
  messages,
  scroller,
  conv,
  onEnter,
}: {
  /** The panels' messages in panel order, the opened one as the pane presents it. */
  messages: readonly EngineMessage[];
  scroller?: RefObject<HTMLElement | null>;
  /** The conversation's wrapper, whose width picks the thin form. */
  conv?: RefObject<HTMLElement | null>;
  onEnter: () => void;
}) {
  const [sc, setSc] = useState<HTMLElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [here, setHere] = useState<string | null>(null);
  const [stop, setStop] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [shown, setShown] = useState(true);
  const ids = messages.map((m) => m.id).join(" ");

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

  /* The ring: the panel with the most of itself in view, a tie to the later one. */
  useEffect(() => {
    const sc = scroller?.current;
    if (!sc) return;
    let cancel: (() => void) | null = null;
    const look = (): void => {
      cancel = null;
      const view = viewOf(sc);
      let best: string | null = null;
      let most = 0;
      for (const el of sc.querySelectorAll<HTMLElement>("[data-conv-id]")) {
        const r = cssRect(el);
        const px = Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top);
        if (px > 0 && px >= most) { most = px; best = el.dataset.convId ?? null; }
      }
      setHere(best);
    };
    const soon = (): void => { if (!cancel) cancel = nextFrame(window, look); };
    look();
    sc.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", soon);
    return () => {
      cancel?.();
      sc.removeEventListener("scroll", soon);
      window.removeEventListener("resize", soon);
    };
  }, [scroller, ids]);

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

  const panelOf = (id: string): HTMLElement | null =>
    scroller?.current?.querySelector<HTMLElement>(`[data-conv-id="${CSS.escape(id)}"]`) ?? null;
  const jump = (id: string): void => {
    setStop(id);
    const panel = panelOf(id);
    if (panel) scrollIntoViewProgrammatically(panel, { block: "start" });
    onEnter();
  };
  const tabStop = stop !== null && ids.split(" ").includes(stop) ? stop : here ?? messages[messages.length - 1]?.id ?? null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".tm-mb")];
    const i = all.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === "ArrowDown") j = Math.min(all.length - 1, i + 1);
    else if (e.key === "ArrowUp") j = Math.max(0, i - 1);
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = all.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const id = all[j]!.dataset.for!;
    setStop(id);
    all[j]!.focus({ preventScroll: true });
  };

  if (sc && !beside) {
    return (
      <div className="thread-marks" data-narrow={narrow ? "" : undefined} hidden={!shown}>
        <ThreadMarksBar messages={messages} here={here} tabStop={tabStop} onJump={jump} onKey={onKey} />
      </div>
    );
  }
  if (!host) return null;
  return createPortal(
    <ThreadMarksBar messages={messages} here={here} tabStop={tabStop} onJump={jump} onKey={onKey} onWheel={onWheel} />,
    host,
  );
}

/** The toolbar itself, drawn into the column's box. */
export function ThreadMarksBar({
  messages,
  here,
  tabStop,
  onJump,
  onKey,
  onWheel,
}: {
  messages: readonly EngineMessage[];
  here: string | null;
  tabStop: string | null;
  onJump: (id: string) => void;
  onKey?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onWheel?: (e: WheelEvent<HTMLDivElement>) => void;
}) {
  const tm = useTranslations("message");
  const n = messages.length;
  return (
    <div className="tm-bar" role="toolbar" aria-orientation="vertical" aria-label={tm("marksAria")} onKeyDown={onKey} onWheel={onWheel}>
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
            title={label}
            aria-current={m.id === here ? "location" : undefined}
            onClick={() => onJump(m.id)}
          >
            <i className={`tm-sq ${kind}`} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
