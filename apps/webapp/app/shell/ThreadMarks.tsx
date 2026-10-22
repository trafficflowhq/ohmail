"use client";

/**
 * THE CONVERSATION'S SQUARES, beside its panels — one per message in panel order (oldest first):
 * solid accent while unread, the same square dimmed once read, hollow for the account's own. A
 * square never carries a count or text; its name says which message it is and its state. The
 * panel most in view gets a neutral ring (display only). A press or Enter brings that message's
 * panel to the top and enters the visit. A vertical toolbar with one tab stop (roving); ↑/↓, Home
 * and End move along it. Sticky at the scrollport's top with no flow height, drawn in the
 * conversation's left padding, so it never covers a panel.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { isOwnOutbound, type EngineMessage } from "@ohmail/client-engine";
import { cssRect } from "@ohmail/ui";
import { senderName } from "./format";
import { scrollIntoViewProgrammatically } from "./programmatic-scroll";
import { nextFrame, viewOf } from "./reader-seen";

/** Below this width the conversation keeps its panels wide and the column takes the thin form. */
const NARROW_PX = 560;

export function ThreadMarks({
  messages,
  scroller,
  onEnter,
}: {
  /** The panels' messages in panel order, the opened one as the pane presents it. */
  messages: readonly EngineMessage[];
  scroller?: RefObject<HTMLElement | null>;
  onEnter: () => void;
}) {
  const tm = useTranslations("message");
  const self = useRef<HTMLDivElement>(null);
  const [here, setHere] = useState<string | null>(null);
  const [stop, setStop] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const ids = messages.map((m) => m.id).join(" ");

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

  /* The thin form, by the conversation's own width rather than the window's. */
  useEffect(() => {
    const conv = self.current?.parentElement;
    if (!conv || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setNarrow(cssRect(conv).width < NARROW_PX));
    ro.observe(conv);
    return () => ro.disconnect();
  }, []);

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

  const n = messages.length;
  return (
    <div className="thread-marks" ref={self} data-narrow={narrow ? "" : undefined}>
      <div className="tm-bar" role="toolbar" aria-orientation="vertical" aria-label={tm("marksAria")} onKeyDown={onKey}>
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
              onClick={() => jump(m.id)}
            >
              <i className={`tm-sq ${kind}`} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
