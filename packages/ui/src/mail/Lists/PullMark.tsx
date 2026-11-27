import { pullMark, pullMarkStyle } from "../../base/tokens.js";
import "./pull-mark.css";

export interface PullMarkProps {
  /** How far the list is drawn down, in the page's px: the room the pull has opened over it. */
  pulled: number;
  /** Letting go now pulls new mail: the mark is whole. */
  armed: boolean;
  /** The rendered pull distance at which the mark is whole. */
  fullAt?: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The mark in the room a list opens when it is pulled down at its top: a full stop that grows in the room's
 * middle, a ring until letting go will pull, then whole. For the eye alone: what the pull did is said elsewhere.
 * It stands at the top of the room that holds it, which is as high as `pulled`.
 */
export function PullMark({ pulled, armed, fullAt }: PullMarkProps) {
  const { center, opacity, scale } = pullMarkStyle(pulled, fullAt);
  return (
    <i
      className="oh-pullmark"
      aria-hidden="true"
      data-armed={armed ? "" : undefined}
      style={{
        width: pullMark.dragSize,
        height: pullMark.dragSize,
        boxShadow: `inset 0 0 0 ${pullMark.dragStroke}px var(--hot)`,
        opacity: round(opacity),
        transform: `translateY(calc(${round(center)}px - 50%)) scale(${round(scale)})`,
      }}
    />
  );
}
