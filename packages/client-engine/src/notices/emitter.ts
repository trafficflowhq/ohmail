/**
 * WHAT A SURFACE HANDS IN TO DRAW NOTICES. One interface for the page, the desktop's window and the
 * phone's page; the shell hands it in with the host's device part, and a surface that draws none
 * hands in no emitter at all. One caller decides (the gate) and posts; an emitter decides nothing.
 */
import type { EventLabel, Notice, NoticeAct, NoticeKind } from "./kinds.js";

/**
 * An alert to ring later, set ahead so that it rings with the app closed and with no connection.
 * Numbers and the event's label: whatever rings it writes the words, and asks first whether it may
 * still ring (`ring.ts`). Made only by `aheadAlert` (`make.ts`); it has no member for a sentence, a
 * place, a person or the account it belongs to.
 */
export interface NoticeAhead {
  /** One alert of one occurrence: the same id replaces, a missing id is taken back. */
  readonly id: string;
  readonly eventId: string;
  /** When it rings, and when the occurrence starts: milliseconds since the epoch. `atMs` is the start less the lead. */
  readonly atMs: number;
  readonly startMs: number;
  readonly allDay: boolean;
  readonly label: EventLabel;
  /** Whole minutes before the start, 0 to `NOTICE_LEAD_MAX_MIN`. */
  readonly leadMin: number;
  readonly acts: readonly NoticeAct[];
}

/**
 * WHAT AN EMITTER ANSWERS FOR ONE NOTICE: `true` once the platform took it, `false` where nothing
 * was drawn (the surface is the one being looked at, the platform refused, it could not be handed
 * over); at once, or when the platform has answered. Never a rejection. The caller keeps what it
 * has told of the account's devices by this answer alone, so only `true` counts: an emitter that
 * answers nothing is read as one that drew nothing, and what it was handed is told again.
 */
export type NoticeTaken = boolean | Promise<boolean>;
/** The most alerts a surface is handed ahead, and how far ahead they reach. */
export const AHEAD_MAX = 64;
export const AHEAD_DAYS = 8;
/** The longest id an alert set ahead has: an event's id, its start and its lead. */
export const AHEAD_ID_MAX = 160;
/**
 * How late an alert may still ring, in milliseconds. A ringer that wakes later than this after an
 * alert's minute draws nothing for it: an alert says how long until the start, and said late that
 * is no longer true.
 */
export const AHEAD_LATE_MS = 120_000;

/**
 * The alerts a surface is handed to ring later: one account's, whole. Made only by `aheadSet`
 * (`make.ts`). The scope is the set's, not an alert's: whatever holds a set holds one account's
 * alerts, and drops all of them the moment that account is no longer the signed-in one.
 */
export interface AheadSet {
  /** The account's scope the alerts were made under. */
  readonly scope: string;
  /** Ascending by `atMs`, each id once, at most {@link AHEAD_MAX}, none further ahead than {@link AHEAD_DAYS}. */
  readonly alerts: readonly NoticeAhead[];
}

export interface NoticeEmitter {
  /** The kinds this surface draws. The pane offers a switch for these only, and the gate hands over no other. */
  readonly carries: readonly NoticeKind[];
  /** The acts its notices can carry. A notice is handed only these. */
  readonly acts: readonly NoticeAct[];
  /** Draw one notice, and say whether the platform took it. Never throws: a notice that cannot be shown takes nothing down. */
  /** A single new letter can be opened locally. The id belongs to the opening act, outside the notice. */
  post(notice: Notice, current?: () => boolean, letter?: string): NoticeTaken | void;
  /**
   * THE CALENDAR'S HALF. A surface that can ring by itself (the desktop's shell, a phone's alarms)
   * takes the whole set here, replacing the one before: an alert missing from the new set is taken
   * back, an empty set takes all back, and a set of another scope leaves nothing of the one before.
   * It never throws. A surface that cannot answers `none`, in that word: the caller then rings by
   * its own timers while the page lives. Every surface answers one or the other; leaving the member
   * out does not compile, so "cannot" is never what an unanswered question defaults to.
   */
  readonly ahead: ((set: AheadSet) => void) | "none";
}
