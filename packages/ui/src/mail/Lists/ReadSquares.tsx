import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { cssPoint, cssRect, type CssRect } from "../../base/ui-zoom.js";
import { animate } from "../../motion/motion.js";
import { SquareTip, useSquareTip } from "./square-tip.js";
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
  /** The measured square pitch for a horizontal touch walk. */
  pitch?: number;
  /** An upright run has a fixed track. Its slots move by transform. */
  column?: { pitch: number; count: number };
}

export interface ReadSquaresProps {
  ref?: Ref<HTMLSpanElement>;
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
  /** A touch drag on a long reader run walks one letter per square pitch. */
  touchWalk?: boolean;
  /**
   * Each square's name, said to a screen reader ("Anna Roth, Mon 08:00"). With `onJump` the squares are then one
   * roving set the keyboard walks: one tab stop, on the reader's square; the arrows, Home and End move it; Enter or
   * Space opens that message. Without names they stay a picture the pointer presses.
   */
  names?: readonly string[];
  ids?: readonly string[];
  tips?: readonly ReactNode[];
  /** The keys moved onto a square (a run then pulls a square beyond it over: `squaresWindow`'s `focus`). */
  onFocusSquare?: (index: number) => void;
}

/** The roving tab stop of the squares, and their keys: it rests on the reader's square until the keys move it. */
function useSquareKeys(count: number, here: number | undefined, on: boolean, props: ReadSquaresProps) {
  const [stop, setStop] = useState<string | number | null>(null);
  const current = here === undefined ? undefined : (props.ids?.[here] ?? here);
  const [was, setWas] = useState(current);
  if (was !== current) {
    setWas(current);
    setStop(null);
  }
  const index = typeof stop === "string" ? props.ids?.indexOf(stop) : stop;
  const at = Math.min(index != null && index >= 0 ? index : (here ?? 0), Math.max(count - 1, 0));
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    const slot = (event.target as HTMLElement).closest<HTMLElement>("[data-square]");
    if (!on || !slot || event.altKey || event.ctrlKey || event.metaKey) return;
    const from = Number(slot.dataset.square);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      props.onJump?.(from);
      return;
    }
    const back = props.axis === "column" ? "ArrowUp" : "ArrowLeft";
    const forward = props.axis === "column" ? "ArrowDown" : "ArrowRight";
    const to =
      event.key === back
        ? Math.max(from - 1, 0)
        : event.key === forward
          ? Math.min(from + 1, count - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (to === from) return;
    setStop(props.ids?.[to] ?? to);
    slot.parentElement?.querySelector<HTMLElement>(`[data-square="${to}"]`)?.focus({ preventScroll: true });
    props.onFocusSquare?.(to);
  };
  return { at, keys };
}

interface Finger {
  id: number;
  from: number;
  at: number;
  along: number;
  across: number;
  pitch: number;
  moving: boolean;
}

function useSquareDrag(props: ReadSquaresProps, cancelTip: () => void) {
  const finger = useRef<Finger | null>(null);
  const swiped = useRef(false);
  const { axis, here, onJump, run, squares, touchWalk } = props;
  const point = (event: PointerEvent<HTMLElement>) => {
    const { x, y } = cssPoint(event);
    return axis === "column" ? { along: y, across: x } : { along: x, across: y };
  };
  const start = (event: PointerEvent<HTMLElement>) => {
    if (!event.isPrimary) return;
    finger.current = null;
    swiped.current = false;
    if (!touchWalk || event.pointerType !== "touch" || here === undefined) return;
    const pitch =
      run?.column?.pitch ??
      run?.pitch ??
      parseFloat(getComputedStyle(event.currentTarget).getPropertyValue("--oh-readsquares-pitch"));
    if (!(pitch > 0)) return;
    finger.current = { ...point(event), id: event.pointerId, from: here, at: here, pitch, moving: false };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const drag = finger.current;
    if (!drag || drag.id !== event.pointerId) return;
    const at = point(event);
    const travel = drag.along - at.along;
    if (!drag.moving) {
      const across = Math.abs(at.across - drag.across);
      if (across >= 6 && across > Math.abs(travel)) {
        finger.current = null;
        return;
      }
      if (Math.abs(travel) < 6) return;
      drag.moving = true;
      swiped.current = true;
      cancelTip();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const to = Math.max(0, Math.min(squares.length - 1, drag.from + Math.round(travel / drag.pitch)));
    if (to === drag.at) return;
    drag.at = to;
    onJump?.(to);
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    if (finger.current?.id === event.pointerId) finger.current = null;
  };
  const lost = (event: PointerEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) end(event);
  };
  const handlers = touchWalk
    ? {
        onPointerDown: start,
        onPointerMove: move,
        onPointerUp: end,
        onPointerCancel: end,
        onLostPointerCapture: lost,
      }
    : undefined;
  return { handlers, suppressClick: () => swiped.current };
}

/**
 * How far a conversation is read, and where the reader is in it. Longer than its room, a run of the
 * squares stands and each edge that hides more says how many; nothing is ever cut.
 */
export function ReadSquares(props: ReadSquaresProps) {
  const { squares, here, axis, label, run, onJump, names } = props;
  /* A control the keyboard stops on only where a press goes somewhere and each square can be named. */
  const walks = Boolean(onJump && names);
  const { at, keys } = useSquareKeys(squares.length, here, walks, props);
  const tip = useSquareTip();
  const drag = useSquareDrag(props, tip.cancel);
  const before = run ? run.from : 0;
  const after = run ? squares.length - run.to : 0;
  const long = before > 0 || after > 0;
  const track = run?.column;
  let edge = before && track ? track.count : 0;
  const slots = track
    ? run.scale.map((k) => {
        const size = Math.round(track.pitch * k);
        const center = edge + size / 2;
        edge += size;
        return { "--oh-square-y": `${center}px`, "--oh-readsquares-k": k } as CSSProperties;
      })
    : null;
  const ring = useRef<HTMLElement>(null);
  const last = useRef<CssRect | null>(null);

  /* The ring is drawn in the square it stands on; when the reader moves it glides there from where it stood. */
  useLayoutEffect(() => {
    if (track) return;
    const el = ring.current;
    const now = el ? cssRect(el) : null;
    const was = last.current;
    last.current = now;
    if (!el || !now || !was) return;
    const [dx, dy] = [was.left - now.left, was.top - now.top];
    if (dx === 0 && dy === 0) return;
    animate(el, "sq", {
      ease: "--e-swift",
      keyframes: [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
    });
  }, [here, before, after, track]);

  const jump = onJump
    ? (event: MouseEvent<HTMLElement>) => {
        const slot = (event.target as HTMLElement).closest<HTMLElement>("[data-square]");
        if (!slot) return;
        event.stopPropagation();
        if (!tip.suppressClick() && !(event.detail && drag.suppressClick()))
          onJump(Number(slot.dataset.square));
      }
    : undefined;
  const room =
    run?.room === undefined
      ? undefined
      : ({
          "--oh-readsquares-room": `${run.room}px`,
          ...(track ? { "--oh-square-pitch": `${track.pitch}px`, "--oh-square-end": `${edge}px` } : {}),
        } as CSSProperties);

  return (
    <span
      ref={props.ref}
      className="oh-readsquares"
      role="group"
      aria-label={label}
      data-axis={axis}
      data-long={long ? "" : undefined}
      data-motion-track={track ? "" : undefined}
      data-press={onJump ? "" : undefined}
      data-touch-walk={props.touchWalk ? "" : undefined}
      style={room}
      onClick={jump}
      {...drag.handlers}
      onKeyDown={walks ? keys : undefined}
    >
      <i className="oh-readsquares-more" data-on={before ? "" : undefined} aria-hidden="true">
        {before ? `+${before}` : null}
      </i>
      {squares.map((kind, index) => {
        const k = run ? (run.scale[index] ?? 0) : 1;
        return (
          <i
            key={props.ids?.[index] ?? index}
            className={walks ? "oh-control oh-readsquares-slot" : "oh-readsquares-slot"}
            role={walks ? "button" : undefined}
            aria-label={walks ? names![index] : undefined}
            aria-current={walks && index === here ? "true" : undefined}
            tabIndex={walks ? (index === at ? 0 : -1) : undefined}
            data-hold-tip={props.tips ? "" : undefined}
            onContextMenu={props.tips ? (event) => event.preventDefault() : undefined}
            onPointerEnter={props.tips ? tip.enter : undefined}
            onPointerLeave={props.tips ? tip.leave : undefined}
            onPointerDown={props.tips ? tip.down : undefined}
            onPointerUp={props.tips ? tip.up : undefined}
            onPointerCancel={props.tips ? tip.cancel : undefined}
            onFocus={props.tips ? (event) => tip.showForFocus(event.currentTarget) : undefined}
            onBlur={props.tips ? tip.leave : undefined}
            data-kind={kind}
            data-square={index}
            data-here={index === here ? "" : undefined}
            data-small={k > 0 && k < 1 ? "" : undefined}
            data-off={k === 0 ? "" : undefined}
            style={slots?.[index] ?? (k === 1 ? undefined : ({ "--oh-readsquares-k": k } as CSSProperties))}
          >
            <b className="oh-readsquares-face" />
            {index === here && k > 0 ? (
              <i ref={ring} className="oh-readsquares-ring" aria-hidden="true" />
            ) : null}
          </i>
        );
      })}
      {tip.anchor && props.tips ? (
        <SquareTip anchor={tip.anchor}>{props.tips[Number(tip.anchor.dataset.square)]}</SquareTip>
      ) : null}
      <i className="oh-readsquares-more" data-on={after ? "" : undefined} data-end="" aria-hidden="true">
        {after ? `+${after}` : null}
      </i>
    </span>
  );
}
