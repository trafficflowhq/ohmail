/**
 * WHAT A CHIP OF THE GRID SAYS, as plain values a view hands the kit's chip: the event's face (made by the calendar's
 * model from its record, its calendar and its marks) and where the grid placed it. No markup here.
 */
import type { Pill } from "./all-day.js";
import type { TimeBlock } from "./model.js";
import type { GridItem } from "./place.js";

/** An event as the views show it: its times, and the face its record, calendar and marks give it. */
export interface GridEvent extends GridItem {
  readonly title: string;
  readonly recordId?: string;
  /** The calendar's hue, `"neutral"` for one without, `null` for an event on no calendar yet. */
  readonly tone: number | "neutral" | null;
  readonly state: "plain" | "to-answer" | "from-mail" | "draft" | "maybe" | "off";
  readonly repeats: "series" | "apart" | null;
  readonly viewOnly: boolean;
  /** Something waits for the person: the dot at the line's end. */
  readonly waits: boolean;
  /** What the queue says of it, in the second line's place: waiting, not saved. */
  readonly status: { readonly text: string; readonly failed: boolean } | null;
  /** The second line: the place. */
  readonly second: string | null;
}

interface FaceOf {
  readonly title: string;
  readonly recordId?: string;
  readonly saving?: true;
  readonly tone: number | "neutral" | null;
  readonly state: GridEvent["state"];
  readonly open: boolean;
  readonly waits: boolean;
  readonly repeats: "series" | "apart" | undefined;
  readonly viewOnly: boolean;
}

const faceOf = (e: GridEvent, open: boolean): FaceOf => ({
  title: e.title,
  ...(e.recordId && { recordId: e.recordId }),
  ...(e.status && !e.status.failed && { saving: true as const }),
  tone: e.tone,
  state: e.state,
  open,
  waits: e.waits,
  repeats: e.repeats ?? undefined,
  viewOnly: e.viewOnly,
});

export interface BlockChip extends FaceOf {
  readonly place: {
    top: number;
    height: number;
    column: number;
    columns: number;
    lap: boolean;
    room: number | undefined;
  };
  readonly second: string | undefined;
  readonly status: { text: string; failed: boolean } | undefined;
  readonly nowCrosses: boolean;
  /** Its edges lengthen it: an event that can be changed, and only on the day it starts and ends. */
  readonly handles: boolean;
}

export function blockChip(b: TimeBlock<GridEvent>, open: boolean): BlockChip {
  const e = b.item;
  return {
    ...faceOf(e, open),
    place: { top: b.top, height: b.height, column: b.column, columns: b.columns, lap: b.lap, room: b.roomPx },
    second: e.second ?? undefined,
    status: e.status === null ? undefined : { text: e.status.text, failed: e.status.failed },
    nowCrosses: b.nowCrosses,
    handles: !e.viewOnly && !b.before && !b.after,
  };
}

export interface PillChip extends FaceOf {
  readonly first: number;
  readonly last: number;
  readonly row: number;
}

export function pillChip(p: Pill<GridEvent>, open: boolean): PillChip {
  return { ...faceOf(p.item, open), first: p.first, last: p.last, row: p.row };
}
