/**
 * The conversation's squares: beside the letters, or along the head on a phone. A press lands on that letter. A
 * conversation longer than the room stands a run of its squares around the one the reader is on, each edge that
 * hides more saying how many; nothing is cut. The room is the column's height beside the letters (the tokens'
 * upright squares), or the head's slots on a phone (the tokens' row of squares).
 */
import type { EngineMessage } from "@ohmail/wire";
import { useEffect, useMemo, useState } from "react";
import { ReadSquares, type SquaresRun } from "@ohmail/ui/mail";
import { squaresWindow } from "@ohmail/ui/squares-window";
import { squareKindsOf, type ThreadWalk } from "@ohmail/app-logic/reader";
import { useText } from "../text/index.js";

interface Fit {
  readonly room: number;
  readonly pitch: number;
  readonly count: number;
}

/** The room the squares have, read off the tokens and the column; null where nothing is laid out. */
function useFit(axis: "column" | "head", column: HTMLElement | null): Fit | null {
  const [fit, setFit] = useState<Fit | null>(null);
  useEffect(() => {
    const win = column?.ownerDocument.defaultView;
    if (!column || !win) return;
    const read = (): void => {
      const cs = win.getComputedStyle(column.ownerDocument.documentElement);
      const px = (name: string): number => parseFloat(cs.getPropertyValue(name));
      const next =
        axis === "column"
          ? { room: column.clientHeight, pitch: px("--sq-y") + px("--sq-y-gap"), count: px("--sq-more-y") }
          : {
              room: px("--sq-slots") * (px("--sq") + px("--sq-gap")) + px("--sq-more"),
              pitch: px("--sq") + px("--sq-gap"),
              count: px("--sq-more"),
            };
      const ok = next.room > 0 && next.pitch > 0 && next.count >= 0;
      setFit((was) =>
        !ok
          ? null
          : was && was.room === next.room && was.pitch === next.pitch && was.count === next.count
            ? was
            : next,
      );
    };
    read();
    win.addEventListener("resize", read);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    ro?.observe(column);
    return () => {
      win.removeEventListener("resize", read);
      ro?.disconnect();
    };
  }, [axis, column]);
  return fit;
}

export function Squares({
  messages,
  walk,
  axis,
  column,
}: {
  messages: readonly EngineMessage[];
  walk: ThreadWalk;
  axis: "column" | "head";
  /** The column the squares stand beside: their room. */
  column: HTMLElement | null;
}) {
  const t = useText("reader");
  const kinds = squareKindsOf(messages);
  const unread = kinds.filter((k) => k === "unseen").length;
  const fit = useFit(axis, column);
  const n = kinds.length;
  const current = walk.here >= 0 ? walk.here : n - 1;
  const run: SquaresRun | undefined = useMemo(() => {
    if (fit === null || n * fit.pitch <= fit.room) return undefined;
    const w = squaresWindow({ n, current, room: fit.room, pitch: fit.pitch, count: fit.count });
    return { from: w.from, to: w.to, scale: w.scale };
  }, [fit, n, current]);
  return (
    <ReadSquares
      squares={kinds}
      here={walk.here >= 0 ? walk.here : undefined}
      axis={axis}
      label={t("squares", { count: messages.length, unread })}
      run={run}
      onJump={(i) => {
        walk.jump(i);
      }}
    />
  );
}
