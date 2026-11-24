import { useLayoutEffect, type RefObject } from "react";

/** Keep the full heading in flow. The scroller clips away the excess above its sticky position. */
export function useReadingHeadMotion(
  header: RefObject<HTMLElement | null>,
  subject: string | undefined,
  names: string | undefined,
  hasSquares: boolean,
) {
  useLayoutEffect(() => {
    const head = header.current;
    const port = head?.closest<HTMLElement>("[data-reading-scroll]");
    const title = head?.querySelector<HTMLElement>(".oh-readinghead-subject");
    const byline = head?.querySelector<HTMLElement>(".oh-readinghead-byline");
    const participants = byline?.querySelector<HTMLElement>(".oh-readinghead-names");
    const squares = hasSquares
      ? head?.querySelector<HTMLElement>(".oh-readinghead-sub > .oh-readsquares")
      : null;
    const win = head?.ownerDocument.defaultView;
    if (!head || !win) return;

    let travel = 0;
    let progress = -1;
    let frame = 0;
    const setPixels = (property: string, value: number) => head.style.setProperty(property, `${value}px`);
    const paint = () => {
      frame = 0;
      const next = port && travel > 0 ? Math.min(1, Math.max(0, port.scrollTop / travel)) : 0;
      if (next === progress) return;
      progress = next;
      head.style.setProperty("--oh-head-progress", String(progress));
      head.toggleAttribute("data-back", progress >= 0.5);
      if (byline) byline.inert = progress >= 0.48;
    };
    const measure = () => {
      if (participants) {
        participants.toggleAttribute("data-faded", participants.scrollWidth > participants.clientWidth + 1);
      }
      if (!port || !title || head.offsetHeight === 0) return;
      const style = win.getComputedStyle(title);
      const size = parseFloat(style.fontSize);
      const small = parseFloat(style.getPropertyValue("--t-ui"));
      const padding = parseFloat(style.getPropertyValue("--s2"));
      if (!(size > 0 && small > 0 && padding >= 0)) return;

      const scale = Math.min(1, small / size);
      const titleHeight = title.offsetHeight * scale;
      const squareHeight = squares?.offsetHeight ?? 0;
      const separate = Boolean(
        squares && title.offsetLeft + title.offsetWidth * scale + padding > squares.offsetLeft,
      );
      const row = separate ? titleHeight : Math.max(titleHeight, squareHeight);
      const compactHeight = 2 * padding + row + (separate ? squareHeight + padding / 2 : 0);
      const titleTop = padding + (row - titleHeight) / 2;
      const compactSquaresTop = padding + (separate ? row + padding / 2 : (row - squareHeight) / 2);

      // Even a short letter should settle in the compact form if the reader scrolls all the way down.
      travel = Math.max(
        0,
        Math.min(Math.round(head.offsetHeight - compactHeight), port.scrollHeight - port.clientHeight),
      );
      head.setAttribute("data-morph", "");
      setPixels("--oh-head-travel", travel);
      setPixels("--oh-head-title-end", titleTop);
      setPixels("--oh-head-title-shift", travel + titleTop - title.offsetTop);
      head.style.setProperty("--oh-head-scale", String(scale));
      if (squares) {
        setPixels("--oh-head-squares-shift", travel + compactSquaresTop - squares.offsetTop);
      }
      if (frame) win.cancelAnimationFrame(frame);
      paint();
    };
    const scroll = () => {
      if (!frame) frame = win.requestAnimationFrame(paint);
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(head);
    if (port) observer?.observe(port);
    const run = port?.querySelector(".oh-sheet-run");
    if (run) observer?.observe(run);
    if (participants) observer?.observe(participants);
    if (squares) observer?.observe(squares);
    if (title) port?.addEventListener("scroll", scroll, { passive: true });
    head.ownerDocument.fonts?.addEventListener("loadingdone", measure);
    measure();

    return () => {
      if (frame) win.cancelAnimationFrame(frame);
      observer?.disconnect();
      port?.removeEventListener("scroll", scroll);
      head.ownerDocument.fonts?.removeEventListener("loadingdone", measure);
      head.removeAttribute("data-morph");
      head.removeAttribute("data-back");
      if (byline) byline.inert = false;
    };
  }, [header, subject, names, hasSquares]);
}
