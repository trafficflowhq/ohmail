/**
 * THE GATE'S SHAPE: what it compares, and what it answers. Every surface that draws a notice asks
 * one function of this type and draws only what it answers.
 */
import type { NoticeChoices } from "./choices.js";
import type { Clock, Notice, NoticeKind } from "./kinds.js";
import type { NoticedEvent } from "./make.js";

/**
 * What the operating system says about drawing notices at all. `unsupported` is no failure: a
 * platform with no notification centre is a supported place to run, and the pane hides its controls.
 */
export type NoticePermission = "granted" | "denied" | "default" | "unsupported";

/** Where a send a person scheduled stands: it waits, it went wrong, or it is a plain draft again. */
export type SendStanding = "waiting" | "failed" | "draft";

/**
 * The account's named devices as its settings record says them: three whole numbers, and nothing
 * else of a device. A named device is one the Devices list shows by name: a paired phone or browser,
 * a desktop app.
 */
export interface NoticeDevices {
  /** How many were ever made. Only rises: a rise is a new device, whatever else happened. */
  readonly made: number;
  /** How many of them a person took back in Devices. Only rises. */
  readonly revoked: number;
  /** How many are signed in now: what a person is shown. Nothing is decided from it. */
  readonly live: number;
}

/**
 * What a device knows at one instant. Two of these, compared, are an event. Numbers and ids on
 * purpose: a sample that held the letters themselves would put mail text in the one place that
 * has no business holding any.
 */
export interface NoticeSample {
  readonly ohboxUnread: number;
  readonly screenerWaiting: number;
  /** Every draft that has not been sent, by its id. One that was waiting and is listed no more was sent. */
  readonly sends: ReadonlyMap<string, SendStanding>;
  /** The account's named devices; `null` where this surface is not told. */
  readonly devices: NoticeDevices | null;
  /** What the calendar holds; `null` where this surface has no calendar, which makes no calendar notice. */
  readonly calendar: CalendarSample | null;
}

/** An event time whose instant depends on the reader's current zone. */
export interface ReaderTime {
  readonly kind: "date" | "floating";
  readonly value: string;
}

export interface CalendarStanding {
  readonly startMs: number;
  readonly readerTime?: ReaderTime;
  readonly status: "confirmed" | "tentative" | "cancelled";
}

/**
 * What the calendar holds at one instant, as the gate compares it: ids, instants and closed words, never an
 * event's title. An event with a write of this device's that waits, or that the calendar has not taken yet, is
 * none of the person's news: it is kept out of `standing` and `answers` and keeps its place in `invitations`.
 */
export interface CalendarSample {
  /** Invitations shown on the calendar that wait for the person's answer: event ids. */
  readonly invitations: ReadonlySet<string>;
  /** Events somebody else wrote that the person is in: id -> where it stands. */
  readonly standing: ReadonlyMap<string, CalendarStanding>;
  /** The person's own events with invitees: id -> how many said yes, maybe, no. */
  readonly answers: ReadonlyMap<string, readonly [yes: number, maybe: number, no: number]>;
  /** Events letters seem to propose, not yet decided: suggestion ids. */
  readonly found: ReadonlySet<string>;
}

/**
 * What the gate reads to MAKE a calendar notice it has decided on, looked up at the settle: the makers' inputs.
 * It is never part of a sample, so no comparison ever holds an event's title.
 */
export interface CalendarLook {
  /** What a maker reads of an event, and whether it lasts whole days; `null` where it is not held. */
  event(id: string): { readonly noticed: NoticedEvent; readonly allDay: boolean } | null;
  /** When something a letter seems to propose starts, as a moment; `null` where that cannot be said. */
  found(id: string): number | null;
  /** A start on the reader's clock, as a notice drawn now says it. */
  clock(startMs: number, readerTime?: ReaderTime): Clock | null;
}

/**
 * The gate. `before === null` is a surface that has not sampled yet: the answer is nothing, since
 * an app opened with eleven unread letters has not just received eleven. It answers only kinds the
 * surface's emitter carries, never throws, and answers `[]` when nothing may be drawn. Without a
 * `look` it makes no calendar notice.
 */
export type NoticeGate = (
  before: NoticeSample | null,
  after: NoticeSample,
  choices: NoticeChoices,
  permission: NoticePermission,
  carries: readonly NoticeKind[],
  look?: CalendarLook | null,
) => Notice[];
