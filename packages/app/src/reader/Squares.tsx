/**
 * The conversation's squares: beside the letters, or along the head on a phone. A press lands on that letter. A
 * conversation longer than the room stands a run of its squares around the one the reader is on, each edge that
 * hides more saying how many; nothing is cut. The room is the studio's share of the column's height beside the
 * letters (the tokens' upright squares), handed to the capsule so the run stands inside it, or the bar's slots on a
 * phone (the tokens' row of squares).
 */
import type { EngineMessage } from "@ohmail/wire";
import { useLayoutEffect, useMemo, useState } from "react";
import { ReadSquares, type SquaresRun } from "@ohmail/ui/mail";
import { squaresWindow } from "@ohmail/ui/squares-window";
import { squareKindsOf, squareStamp, type ThreadWalk } from "@ohmail/app-logic/reader";
import { useLocale, useText, useTimeZone } from "../text/index.js";

interface Fit {
  readonly room: number;
  readonly pitch: number;
  readonly count: number;
}

/** The room the squares have, read off the tokens and the column; null where nothing is laid out. */
function useFit(axis: "column" | "head", column: HTMLElement | null): Fit | null | undefined {
  const [fit, setFit] = useState<Fit | null>();
  useLayoutEffect(() => {
    const win = column?.ownerDocument.defaultView;
    if (!column || !win) return;
    const read = (): void => {
      const cs = win.getComputedStyle(column.ownerDocument.documentElement);
      const px = (name: string): number => parseFloat(cs.getPropertyValue(name));
      /* The column's room is the studio's (`sqLayout`): the column's height less the capsule's own padding, on a
         desktop at most a little over half of it, and never less than five squares and a count. The capsule is
         handed that room, so the run fitted to it stands inside it. */
      const pitchY = px("--sq-y") + px("--sq-y-gap");
      const countY = px("--sq-more-y");
      const tall = column.clientHeight;
      const desktop = column.ownerDocument.documentElement.dataset.device === "desktop";
      const next =
        axis === "column"
          ? {
              room: Math.max(
                5 * pitchY + countY,
                Math.min(tall - 2 * (px("--s2") || 0) - 4, desktop ? tall * 0.56 : tall),
              ),
              pitch: pitchY,
              count: countY,
            }
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
  waitForFit = true,
}: {
  messages: readonly EngineMessage[];
  walk: ThreadWalk;
  axis: "column" | "head";
  /** The column the squares stand beside: their room. */
  column: HTMLElement | null;
  waitForFit?: boolean;
}) {
  const t = useText("reader");
  const tm = useText("message");
  const locale = useLocale();
  const zone = useTimeZone();
  const [keyboard, setKeyboard] = useState<{ here: string | undefined; at: string } | null>(null);
  const kinds = useMemo(() => squareKindsOf(messages), [messages]);
  const unread = kinds.filter((k) => k === "unseen").length;
  const fit = useFit(axis, column);
  const n = kinds.length;
  const current = walk.here >= 0 ? walk.here : n - 1;
  const currentId = messages[current]?.id;
  const focusedIndex =
    keyboard?.here === currentId ? messages.findIndex((message) => message.id === keyboard.at) : -1;
  const focus = focusedIndex >= 0 ? focusedIndex : undefined;
  const labels = useMemo(() => {
    const now = new Date();
    const words = {
      today: (time: string) => tm("markToday", { time }),
      yesterday: (time: string) => tm("markYesterday", { time }),
    };
    return messages.map((message, index) => {
      const own = kinds[index] === "own";
      const sender = own ? tm("markYou") : message.from.name?.trim() || message.from.address;
      const when = squareStamp(message, now, zone, locale, words);
      const snippet = message.snippet?.trim().replace(/\s+/g, " ") ?? "";
      const cut = snippet.slice(0, 64);
      const line = snippet.length > cut.length ? `${cut.replace(/\s+\S*$/, "") || cut}…` : cut;
      const position = { position: index + 1, count: messages.length };
      const name = own
        ? tm("markMine", position)
        : tm(message.unread ? "markFromUnread" : "markFromRead", { ...position, sender });
      return {
        name,
        tip: (
          <>
            <b>{sender}</b>
            {when ? <time className="oh-square-tip-time">{when}</time> : null}
            {line ? <span className="oh-square-tip-line">{line}</span> : null}
          </>
        ),
      };
    });
  }, [messages, kinds, locale, zone, tm]);
  const run: SquaresRun | undefined = useMemo(() => {
    if (!fit || n * fit.pitch <= fit.room) return undefined;
    const w = squaresWindow({ n, current, focus, room: fit.room, pitch: fit.pitch, count: fit.count });
    return {
      from: w.from,
      to: w.to,
      scale: w.scale,
      ...(axis === "column" ? { room: fit.room, column: { pitch: fit.pitch, count: fit.count } } : {}),
    };
  }, [fit, n, current, focus, axis]);
  // Mount the run at its measured size so its transitions only animate subsequent changes.
  if (waitForFit && fit === undefined) return null;
  return (
    <ReadSquares
      squares={kinds}
      ids={messages.map((message) => message.id)}
      here={walk.here >= 0 ? walk.here : undefined}
      axis={axis}
      label={t("squares", { count: messages.length, unread })}
      run={run}
      names={labels.map(({ name }) => name)}
      tips={labels.map(({ tip }) => tip)}
      onFocusSquare={(at) => {
        const id = messages[at]?.id;
        if (id) setKeyboard({ here: currentId, at: id });
      }}
      onJump={(i) => {
        walk.jump(i);
      }}
    />
  );
}
