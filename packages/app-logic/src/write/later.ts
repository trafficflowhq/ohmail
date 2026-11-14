/**
 * SEND LATER, as the new screen offers it: which times stand, which are refused before the wire, and why none stand
 * at all. The rules are 1.0.11's (`ComposeView`'s panel), carried whole:
 * - a forward is never scheduled;
 * - a letter with files is scheduled only where its files are kept (the server or the desktop's engine says so,
 *   and how many days ahead); where nothing answered, or the answer is no, the times are not offered and that is said;
 * - a file still being read holds a pick as it holds Send;
 * - a time must stand the floor ahead of the panel's opening, and within the files' horizon;
 * - a typed clock the night skips is booked after the gap, and that is said.
 * The server's refusal (against its own clock) stays the authority; this refuses what it can know first.
 */

/** The card owns execution. Write's shortcut sheet uses these same chords to teach it. */
export const SCHEDULE_KEY = "Enter";
export const SCHEDULE_CHORD = `mod+${SCHEDULE_KEY}`;
export const LATER_CHOICES = {
  "1": "evening",
  "2": "tomorrow",
  "3": "monday",
  "4": "custom",
} as const;

/** How far ahead a server keeps a scheduled letter's files; `days: null`: kept by this computer's own engine. */
export interface ScheduleFiles {
  readonly kept: boolean;
  readonly days: number | null;
}

/** A typed clock, as the shell composed it in the person's zone. */
export interface ComposedTime {
  /** The instant to book. */
  readonly at: string;
  /** The night skips the typed hour: the clock it books instead, and the one asked; null when it is as typed. */
  readonly shifted: { readonly booked: string; readonly asked: string } | null;
}

export type LaterRefusal =
  | { readonly why: "forward" }
  | { readonly why: "filesNotHere" }
  | { readonly why: "filesUnknown" }
  | { readonly why: "attaching"; readonly name: string; readonly count: number };

export interface LaterInput {
  /** When the panel opened. */
  readonly openedAt: number;
  /** The earliest instant a time may go at, from `openedAt` (the shell's floor). */
  readonly floor: number;
  readonly forward: boolean;
  readonly hasFiles: boolean;
  /** The server's answer about files; null: none yet, or none at all. */
  readonly files: ScheduleFiles | null;
  /** The names still being read. */
  readonly attaching: readonly string[];
  /** The shell's presets for `openedAt` (already past the floor). */
  readonly presets: readonly { readonly id: string; readonly at: string }[];
  /** The typed clock, composed; null: nothing typed or not a clock. */
  readonly custom: ComposedTime | null;
}

export interface LaterPlan {
  /** Why no time is offered; null: the times stand. */
  readonly refusal: LaterRefusal | null;
  readonly presets: readonly { readonly id: string; readonly at: string }[];
  /** The typed time, when it may be booked. */
  readonly custom: ComposedTime | null;
  /** Why the typed time may not be booked; null: it may, or nothing is typed. */
  readonly customRefused: "past" | "tooFar" | null;
  /** The files' horizon in days, said under the times; null: none. */
  readonly horizonDays: number | null;
  /** The appointment waits for this computer's app. */
  readonly thisComputer: boolean;
  /** The latest instant a time may stand at; null: no horizon. */
  readonly latest: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function laterPlan(input: LaterInput): LaterPlan {
  const { files, hasFiles } = input;
  const refusal: LaterRefusal | null = input.forward
    ? { why: "forward" }
    : hasFiles && files?.kept !== true
      ? { why: files === null ? "filesUnknown" : "filesNotHere" }
      : input.attaching.length > 0
        ? { why: "attaching", name: input.attaching[0]!, count: input.attaching.length }
        : null;
  const horizonDays = hasFiles && files?.kept === true ? files.days : null;
  const latest = horizonDays === null ? null : input.openedAt + horizonDays * DAY_MS;
  const within = (at: string): boolean => latest === null || Date.parse(at) <= latest;
  const ahead = (at: string): boolean => Date.parse(at) >= input.floor;
  const custom = input.custom;
  const customRefused =
    custom === null ? null : !ahead(custom.at) ? "past" : !within(custom.at) ? "tooFar" : null;
  return {
    refusal,
    presets: refusal === null ? input.presets.filter((p) => within(p.at) && ahead(p.at)) : [],
    custom: refusal === null && custom !== null && customRefused === null ? custom : null,
    customRefused: refusal === null ? customRefused : null,
    horizonDays,
    thisComputer: files?.kept === true && files.days === null,
    latest,
  };
}
