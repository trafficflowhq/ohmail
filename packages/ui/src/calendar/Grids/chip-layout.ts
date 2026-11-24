import type { CSSProperties } from "react";

/** Where a block stands in its day's column, in px from the column's first hour. */
export interface BlockPlace {
  top: number;
  /** As tall as its time; the chip never draws under the shortest height, and leaves 2 px to the next. */
  height: number;
  /** Of `columns` side by side, which one this is, from 0. */
  column?: number;
  columns?: number;
  /** The later of two that overlap: set in, and lapping over the earlier. */
  lap?: boolean;
  /** How much of this block stands above a later one that laps over it, in px. */
  room?: number;
  /** What a mark at the column's end takes of the block's width, in px. */
  bay?: number;
}

export interface BlockLayout {
  style: CSSProperties;
  /** Titles at the small size: a narrow lane, or a block too short for the larger line. */
  small: boolean;
  /** Title and nothing else, on the block's middle line. */
  one: boolean;
  /** Under a lap that leaves less than a line and its air: the title keeps to the block's top. */
  tight: boolean;
  /** The lines the title may take. */
  lines: number;
  /** Whether a second line has room under the title. */
  second: boolean;
  /** The drawn height: both handles fit from 28 px. */
  height: number;
}

/* The shortest a block is drawn, the title's line at each size, and what a block keeps free of words. */
const SHORTEST = 22;
const LINE = 20;
const LINE_SMALL = 16.25;
const WORDLESS = 8;
/* A column's own margins: 2 px before its events and 6 after. */
const SPAN = "(100% - 8px)";

/** What a block of this place looks like: its box, its type size and how many lines its words get. */
export function blockLayout(
  place: BlockPlace,
  o: { dense?: boolean; shortest?: number; hasSecond: boolean },
): BlockLayout {
  const { column = 0, columns = 1, lap = false, room, bay = 0 } = place;
  const height = Math.max(place.height, o.shortest ?? SHORTEST) - 2;
  const small = Boolean(o.dense) || (columns > 1 && !lap) || height < 18 || (room !== undefined && room < 25);
  const line = small ? LINE_SMALL : LINE;
  const lines = Math.floor(((room === undefined ? height : Math.min(height, room)) - WORDLESS) / line);
  const one = lines < 2 && height < line + 14;
  const second = o.hasSecond && lines >= 2 && !one;
  const width = lap
    ? `calc(${SPAN} * .86${bay ? ` - ${bay}px` : ""})`
    : `calc(${SPAN} / ${columns} - ${(columns > 1 ? 2 : 0) + bay}px)`;
  const left = lap ? `calc(2px + ${SPAN} * .14)` : `calc(2px + ${SPAN} * ${column / columns})`;
  return {
    style: {
      top: place.top,
      height,
      left,
      width,
      "--oh-ev-lines": Math.max(1, lines - (second ? 1 : 0)),
    } as CSSProperties,
    small,
    one,
    tight: room !== undefined && room < 22,
    lines,
    second,
    height,
  };
}
