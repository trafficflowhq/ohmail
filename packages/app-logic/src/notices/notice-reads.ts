import {
  devicesOf,
  type AheadSet,
  type CalendarLook,
  type CalendarSample,
  type Clock,
  type EntityReader,
  type NoticeChoices,
  type NoticeDevices,
  type NoticeEmitter,
  type NoticePermission,
  type SnapshotSummary,
} from "@ohmail/client-engine";
import { devicesListedOf } from "./devices-listed.js";
import { toldDevicesIn, type ToldDevices, type ToldDevicesStore } from "./told-devices.js";

/**
 * A surface's emitter as its shell hands it in: the seam's emitter, and the taking back. `takeBack`
 * closes what this surface drew and still shows, and stops what it set to ring later, at sign-out
 * and at an account switch. It never throws, and a surface whose platform gives no way back says
 * so where it is built.
 */
export interface HostNoticeEmitter extends NoticeEmitter {
  readonly showsMailDetails?: true;
  lockSummary?(key: string, run: () => Promise<void>): Promise<void>;
  takeBack(): void;
}

/** What the shell hands the hook. */
export interface NoticesMount {
  /** The copy the rail reads, so a notice's number and the rail's never disagree. */
  readonly reader: EntityReader;
  /** Moves whenever the copy does. */
  readonly version: number;
  /** The copy has settled: mid-catch-up a count is still moving, and is no event. */
  readonly settled: boolean;
  /** The account the copy is of; `null` while there is none. */
  readonly scope: string | null;
  /** The surface's emitter, or `none` where it draws none. */
  readonly emitter: HostNoticeEmitter | "none";
  readonly reads: NoticeReads;
}

/** What the caller reads of the calendar. */
export interface CalendarReads {
  /** Rechecked at a wake, even when nothing in this window has rerendered. */
  liveScope(): string | null;
  changes(
    previous: CalendarSample | null,
    nowMs: number,
  ): { sample: CalendarSample; look: CalendarLook } | null;
  /**
   * The alerts the calendar wants for the account `scope` from `nowMs` on: the set `aheadSet` made
   * of what the calendar's own rule found due (`ring.ts`). `null` while the calendar cannot be read.
   * A set under any other scope than the one asked for is not taken.
   */
  ahead(scope: string, nowMs: number): AheadSet | null;
  /** An occurrence's start on the reader's clock, as a notice drawn at `nowMs` says it; `null` where it cannot be said. */
  clock(startMs: number, nowMs: number): Clock | null;
  summary?(
    scope: string,
    nowMs: number,
    time: number,
  ): { readonly summary: SnapshotSummary; readonly zone: string } | null;
}

/** What the caller reads at each settle. Read then, never held: a switch pressed a moment ago counts. */
export interface NoticeReads {
  /** The person's choices on this device. */
  choices(): NoticeChoices;
  /** What the platform says about drawing notices at all. */
  permission(): NoticePermission;
  /**
   * The account's named devices as the engine's own copy holds them (`devicesOf`); `null` where this
   * surface is not told.
   */
  devices(): NoticeDevices | null;
  /** The calendar's alerts; `none`, in that word, where this shell has no calendar to ring for. */
  readonly calendar: CalendarReads | "none";
  /**
   * What the Devices list shows (`devices-listed.ts`) while the person stands at it and is looking at
   * it, else `null`. Where it shows what the record says now, the person is reading what a notice
   * would tell them, so that counts as told.
   */
  atDevices(): ToldDevices | null;
  /** Where this device keeps the numbers it has told of an account's devices. */
  readonly told: ToldDevicesStore;
}

/**
 * WHAT A SURFACE HANDS ITS NOTICES, BUILT ONCE FOR EVERY SURFACE: the web's shell, the desktop's
 * window and the phone's page each hand this their engine, their host's notifications part and
 * their own reader of the stored choices, and hand the caller what it answers. The account's
 * devices are read here and nowhere else, from the engine's own copy, where the settings record
 * lives: the copy a surface presents is not always that one. A surface that built its reads by
 * hand could leave the devices out, and the notice of a new device would be drawn nowhere with
 * every other notice still working.
 *
 * `host` is `null` where the host has no notifications part: the permission is then `unsupported`.
 * `own.atDevices` says the person stands at the Devices pane in a window that is looked at; what the
 * pane's list shows is read here, from what the list of this engine wrote (`devices-listed.ts`).
 * `own.told` is this device's own storage unless a test hands in another.
 */
export function noticeReadsOf(
  engine: { read(): EntityReader },
  host: { permission(): NoticePermission } | null,
  own: {
    choices(): NoticeChoices;
    atDevices(): boolean;
    readonly told?: ToldDevicesStore;
    readonly calendar?: CalendarReads;
  },
): NoticeReads {
  return {
    choices: () => own.choices(),
    permission: () => host?.permission() ?? "unsupported",
    devices: () => devicesOf(engine.read()),
    calendar: own.calendar ?? "none",
    atDevices: () => (own.atDevices() ? devicesListedOf(engine) : null),
    told: own.told ?? toldDevicesIn(),
  };
}
