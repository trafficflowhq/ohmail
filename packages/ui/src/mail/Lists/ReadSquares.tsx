import { useLayoutEffect, useRef, type CSSProperties, type MouseEvent } from "react";
import { animate } from "../../motion/motion.js";
import "./read-squares.css";

/** A message's square: seen, not seen yet, your own, or a reply being written. */
export type SquareKind = "seen" | "unseen" | "own" | "draft";

/** The run that stands when there are more squares than room (`squaresWindow` of `@ohmail/ui/squares-window`). */
export interface SquaresRun {
  from: number;
  to: number;
  /** Each square's scale: 1 whole, a taper step at an edge that hides more, 0 outside the run. */
  scale: readonly number[];
  /** The room the run was fitted to, in px, where it is the column's own and not the tokens'. */
  room?: number;
}

export interface ReadSquaresProps {
  /** One square a message, oldest first. */
  squares: readonly SquareKind[];
  /** The square the reader is on, counted from 0. The ring stands there. */
  here?: number;
  /** `row`: the label in a list row. `column`: upright beside the letters. `head`: along the head, under a finger. */
  axis: "row" | "column" | "head";
  /** Its name, with the counts: "12 messages, 3 unread". */
  label: string;
  /** Without it every square stands whole. */
  run?: SquaresRun;
  /** A press on a square: the conversation opens on that message. */
  onJump?: (index: number) => void;
}

/**
 * How far a conversation is read, and where the reader is in it. Longer than its room, a run of the
 * squares stands and each edge that hides more says how many; nothing is ever cut.
 */
export function ReadSquares({ squares, here, axis, label, run, onJump }: ReadSquaresProps) {
  const before = run ? run.from : 0;
  const after = run ? squares.length - run.to : 0;
  const long = before > 0 || after > 0;
  const ring = useRef<HTMLElement>(null);
  const last = useRef<DOMRect | null>(null);

  /* The ring is drawn in the square it stands on; when the reader moves it glides there from where it stood. */
  useLayoutEffect(() => {
    const el = ring.current;
    const now = el ? el.getBoundingClientRect() : null;
    const was = last.current;
    last.current = now;
    if (!el || !now || !was) return;
    const [dx, dy] = [was.left - now.left, was.top - now.top];
    if (dx === 0 && dy === 0) return;
    animate(el, "sq", {
      ease: "--e-swift",
      keyframes: [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
    });
  }, [here, before, after]);

  const jump = onJump
    ? (event: MouseEvent<HTMLElement>) => {
        const slot = (event.target as HTMLElement).closest<HTMLElement>("[data-square]");
        if (!slot) return;
        event.stopPropagation();
        onJump(Number(slot.dataset.square));
      }
    : undefined;
  const room =
    run?.room === undefined ? undefined : ({ "--oh-readsquares-room": `${run.room}px` } as CSSProperties);

  return (
    <span
      className="oh-readsquares"
      role="group"
      aria-label={label}
      data-axis={axis}
      data-long={long ? "" : undefined}
      data-press={onJump ? "" : undefined}
      style={room}
      onClick={jump}
    >
      <i className="oh-readsquares-more" data-on={before ? "" : undefined} aria-hidden="true">
        {before ? `+${before}` : null}
      </i>
      {squares.map((kind, index) => {
        const k = run ? (run.scale[index] ?? 0) : 1;
        return (
          <i
            key={index}
            className="oh-readsquares-slot"
            data-kind={kind}
            data-square={index}
            data-small={k > 0 && k < 1 ? "" : undefined}
            data-off={k === 0 ? "" : undefined}
            style={k === 1 ? undefined : ({ "--oh-readsquares-k": k } as CSSProperties)}
          >
            <b className="oh-readsquares-face" />
            {index === here && k > 0 ? (
              <i ref={ring} className="oh-readsquares-ring" aria-hidden="true" />
            ) : null}
          </i>
        );
      })}
      <i className="oh-readsquares-more" data-on={after ? "" : undefined} data-end="" aria-hidden="true">
        {after ? `+${after}` : null}
      </i>
    </span>
  );
}
