import "./pull-mark.css";

export interface PullMarkProps {
  /** How far the list is drawn down, in the page's px: the room the pull has opened over it. */
  pulled: number;
  /** Letting go now pulls new mail: the mark is whole. */
  armed: boolean;
}

/* The mark is there once the room is a little open, and at its own size once letting go will pull. */
const SEEN = 20;
const WHOLE = 64;
const SMALL = 0.35;
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The mark in the room a list opens when it is pulled down at its top: a full stop that grows in the room's
 * middle, a ring until letting go will pull, then whole. For the eye alone: what the pull did is said elsewhere.
 * It stands at the top of the room that holds it, which is as high as `pulled`.
 */
export function PullMark({ pulled, armed }: PullMarkProps) {
  const open = Math.max(0, pulled);
  const grown = Math.min(1, open / WHOLE);
  return (
    <i
      className="oh-pullmark"
      aria-hidden="true"
      data-armed={armed ? "" : undefined}
      style={{
        opacity: round(Math.min(1, open / SEEN)),
        transform: `translateY(calc(${round(open / 2)}px - 50%)) scale(${round(SMALL + (1 - SMALL) * grown)})`,
      }}
    />
  );
}
