/**
 * WHAT A SURFACE HANDS IN TO DRAW NOTICES. One interface for the page, the desktop's window and the
 * phone's page; the shell hands it in with the host's device part, and a surface that draws none
 * hands in no emitter at all. One caller decides (the gate) and posts; an emitter decides nothing.
 */
import type { EventLabel, Notice, NoticeAct, NoticeKind } from "./kinds.js";

/**
 * An alert to ring later, set ahead so that it rings with the app closed and with no connection.
 * Numbers and the event's label: whatever rings it writes the words, and checks first that the
 * scope it was set under is still the live one.
 */
export interface NoticeAhead {
  /** One alert of one occurrence: the same id replaces, a missing id is taken back. */
  readonly id: string;
  readonly eventId: string;
  /** When it rings, and when the occurrence starts: milliseconds since the epoch. */
  readonly atMs: number;
  readonly startMs: number;
  readonly allDay: boolean;
  readonly label: EventLabel;
  /** Whole minutes before the start, 0 to `NOTICE_LEAD_MAX_MIN`. */
  readonly leadMin: number;
  readonly acts: readonly NoticeAct[];
}

export interface NoticeEmitter {
  /** The kinds this surface draws. The pane offers a switch for these only, and the gate hands over no other. */
  readonly carries: readonly NoticeKind[];
  /** The acts its notices can carry. A notice is handed only these. */
  readonly acts: readonly NoticeAct[];
  /** Draw one notice. Never throws: a notice that cannot be shown takes nothing down. */
  post(notice: Notice): void;
  /**
   * Take the whole list of alerts to ring later, replacing the one before; an empty list takes all
   * back. `none` where the surface cannot ring by itself: the caller then rings by its own timers
   * while the page lives.
   */
  readonly ahead: ((list: readonly NoticeAhead[]) => void) | "none";
}

/** The most alerts a surface is handed ahead, and how far ahead they reach. */
export const AHEAD_MAX = 64;
export const AHEAD_DAYS = 8;
