import { useLayoutEffect, useRef, useState } from "react";
import { Count } from "./Count.js";
import "./seg.css";

export interface SegOption<V extends string> {
  value: V;
  label: string;
  /** How many stand behind this choice. Zero shows nothing. */
  count?: number | string;
}

export interface SegProps<V extends string> {
  /** The group's name, said to a screen reader. */
  label: string;
  /** Two to five short labels. */
  options: readonly SegOption<V>[];
  value: V;
  onChange?: (value: V) => void;
  /** How close the segments stand on touch. Left out: measured, closer while the row is wider than its line. */
  fit?: SegFit;
}

const FITS = ["wide", "tight", "tighter"] as const;
export type SegFit = (typeof FITS)[number];

/**
 * How close a track's segments stand: `fit` where it is given, else measured, one step closer while
 * the track is wider than what holds it, measured again when `again` changes. Every track of segments
 * in the kit measures the same way.
 */
export function useSegFit(fit: SegFit | undefined, again: unknown) {
  const track = useRef<HTMLSpanElement | null>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    if (fit) return;
    const el = track.current;
    const room = el?.parentElement;
    if (!el || !room) return;
    if (el.scrollWidth > room.clientWidth && measured < FITS.length - 1) setMeasured(measured + 1);
  }, [fit, measured, again]);
  return [track, fit ?? FITS[measured]] as const;
}

/** A few choices on one track. A choice takes effect at once. Not for moving between places. */
export function Seg<V extends string>({ label, options, value, onChange, fit }: SegProps<V>) {
  const [track, fits] = useSegFit(fit, options);
  return (
    <span ref={track} className="oh-seg" role="group" aria-label={label} data-fit={fits}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="oh-control oh-seg-item"
          aria-pressed={option.value === value}
          onClick={() => onChange?.(option.value)}
        >
          {option.label}
          <Count>{option.count}</Count>
        </button>
      ))}
    </span>
  );
}
