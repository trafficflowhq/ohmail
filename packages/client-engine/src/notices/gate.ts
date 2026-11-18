/**
 * THE GATE'S SHAPE: what it compares, and what it answers. Every surface that draws a notice asks
 * one function of this type and draws only what it answers.
 */
import type { NoticeChoices } from "./choices.js";
import type { Notice, NoticeKind } from "./kinds.js";

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
}

/**
 * The gate. `before === null` is a surface that has not sampled yet: the answer is nothing, since
 * an app opened with eleven unread letters has not just received eleven. It answers only kinds the
 * surface's emitter carries, never throws, and answers `[]` when nothing may be drawn.
 */
export type NoticeGate = (
  before: NoticeSample | null,
  after: NoticeSample,
  choices: NoticeChoices,
  permission: NoticePermission,
  carries: readonly NoticeKind[],
) => Notice[];
