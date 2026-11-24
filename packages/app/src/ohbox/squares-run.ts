/**
 * THE RUN OF A ROW'S SQUARES: a conversation longer than the row's room stands a run of its squares around the one
 * the reader is on (the newest where none is), each edge that hides more saying how many, as the shipped row did;
 * nothing is cut. The room is the tokens' (`--sq-slots` squares at `--sq` + `--sq-gap`, and one `--sq-more` count),
 * the room the kit's squares keep along a row. The list reads it off its own scroller, which the tokens reach,
 * again when the scroller's size or the page's face changes, and hands it to its rows. Where nothing is laid out
 * (no tokens reach the list), every square stands whole.
 */
import { createContext, useContext, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { squaresWindow } from "@ohmail/ui/squares-window";
import type { SquaresRun } from "@ohmail/ui/mail";

export interface SquaresRoom {
  room: number;
  pitch: number;
  count: number;
}

function roomOf(el: Element): SquaresRoom | null {
  const view = el.ownerDocument.defaultView;
  if (!view) return null;
  const cs = view.getComputedStyle(el);
  const px = (name: string): number => parseFloat(cs.getPropertyValue(name));
  const pitch = px("--sq") + px("--sq-gap");
  const slots = px("--sq-slots");
  const count = px("--sq-more");
  return pitch > 0 && slots > 0 && count >= 0 ? { room: slots * pitch + count, pitch, count } : null;
}

const same = (a: SquaresRoom | null | undefined, b: SquaresRoom | null): boolean =>
  a === b || (!!a && !!b && a.room === b.room && a.pitch === b.pitch && a.count === b.count);

/** The room a row has for its squares, read off the list's scroller; one object while it holds. */
export function useSquaresRoom(scroller: RefObject<HTMLElement | null>): SquaresRoom | null | undefined {
  const [room, setRoom] = useState<SquaresRoom | null>();
  useLayoutEffect(() => {
    const el = scroller.current;
    const view = el?.ownerDocument.defaultView;
    if (!el || !view) return;
    const look = () => {
      const now = roomOf(el);
      setRoom((was) => (same(was, now) ? was : now));
    };
    look();
    const face = new view.MutationObserver(look);
    face.observe(el.ownerDocument.documentElement, { attributes: true });
    const size = view.ResizeObserver ? new view.ResizeObserver(look) : null;
    size?.observe(el);
    return () => {
      face.disconnect();
      size?.disconnect();
    };
  }, [scroller]);
  return room;
}

/** The list's room, for its rows; none where the list has not measured it. */
export const SquaresRoomContext = createContext<SquaresRoom | null | undefined>(null);

/** The run for `n` squares around square `current` (-1: the newest), or undefined where they all fit. */
export function useSquaresRun(n: number, current: number): SquaresRun | null | undefined {
  const fit = useContext(SquaresRoomContext);
  return useMemo(() => {
    if (fit === undefined) return null;
    if (fit === null || n * fit.pitch <= fit.room) return undefined;
    const w = squaresWindow({ n, current, room: fit.room, pitch: fit.pitch, count: fit.count });
    return { from: w.from, to: w.to, scale: w.scale };
  }, [fit, n, current]);
}
