/**
 * THE ONE CALLER OF A SURFACE'S EMITTER. Mounted once, where the shell holds the copy the rail
 * reads. At each settle of the copy it takes a sample, asks the gate what may be drawn, and hands
 * the emitter each answer. Nothing else calls an emitter's `post`: the gate decides, the emitter
 * draws, and this joins the two.
 *
 * Keyed by the account's scope. A new scope starts from no sample again, so the first sample of
 * the next account draws nothing, and whatever the surface drew for the account left is taken
 * back before anything of the next one is drawn.
 *
 * The account's devices are the one thing not compared with the sample before: they are compared
 * with the numbers this device has told (`told-devices.ts`), which outlive the app, so a device
 * paired while no app was open is told at the next start.
 */
import { useEffect, useRef } from "react";
import {
  decideNotices,
  devicesOf,
  noticeSampleOf,
  type EntityReader,
  type NoticeChoices,
  type NoticeDevices,
  type NoticeEmitter,
  type NoticePermission,
  type NoticeSample,
  type NoticeTaken,
} from "@ohmail/client-engine";
import { devicesListedOf } from "./devices-listed.js";
import { toldDevicesIn, type ToldDevices, type ToldDevicesStore } from "./told-devices.js";

export { devicesListedOf, showDevicesListed } from "./devices-listed.js";

export {
  TOLD_DEVICES_PREFIX,
  toldDevicesIn,
  toldDevicesKey,
  type ToldDevices,
  type ToldDevicesStore,
} from "./told-devices.js";

/**
 * A surface's emitter as its shell hands it in: the seam's emitter, and the taking back. `takeBack`
 * closes what this surface drew and still shows, and stops what it set to ring later, at sign-out
 * and at an account switch. It never throws, and a surface whose platform gives no way back says
 * so where it is built.
 */
export interface HostNoticeEmitter extends NoticeEmitter {
  takeBack(): void;
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
  own: { choices(): NoticeChoices; atDevices(): boolean; readonly told?: ToldDevicesStore },
): NoticeReads {
  return {
    choices: () => own.choices(),
    permission: () => host?.permission() ?? "unsupported",
    devices: () => devicesOf(engine.read()),
    atDevices: () => (own.atDevices() ? devicesListedOf(engine) : null),
    told: own.told ?? toldDevicesIn(),
  };
}

/**
 * The caller without React: what the hook below runs, and what a test drives. `settle` is one
 * settle of the copy under `scope`; `end` is the shell going away.
 */
export class NoticeCaller {
  private scope: string | null = null;
  private before: NoticeSample | null = null;
  /** What was last kept for this scope, for a device whose storage keeps nothing: the app's life then. */
  private told: ToldDevices | null = null;

  constructor(
    private readonly emitter: HostNoticeEmitter,
    private readonly reads: NoticeReads,
  ) {}

  /** One settle of the copy `reader` shows for the account `scope`. */
  settle(scope: string, reader: EntityReader): void {
    if (scope !== this.scope) {
      // Another account, or the first: what was drawn for the one left goes, and nothing of this
      // one is an event until there is something of its own to compare against.
      if (this.scope !== null) this.takeBack();
      this.scope = scope;
      this.before = null;
      this.told = null;
    }
    const seen = this.reads.devices();
    const told = seen === null ? null : this.toldOf(scope, seen);
    const after = noticeSampleOf(reader, seen);
    // Mail is compared with the sample before; the first sample with itself, so nothing of it is
    // an event. The devices are compared with what this device has told, at the first sample too.
    const before: NoticeSample = {
      ...(this.before ?? after),
      devices:
        seen === null || told === null ? null : { made: told.made, revoked: told.revoked, live: seen.live },
    };
    this.before = after;
    const answer = decideNotices(
      before,
      after,
      this.reads.choices(),
      this.reads.permission(),
      this.emitter.carries,
    );
    for (const notice of answer) {
      const taken = this.emitter.post(notice);
      if (notice.kind !== "pairing" || seen === null) continue;
      this.keepOnceTaken(
        scope,
        notice.change === "paired" ? { made: seen.made } : { revoked: seen.revoked },
        taken,
      );
    }
    // The person is reading the list itself, and it shows what the record says now: that is told. A
    // rise whose read of the list has not answered yet, or failed, is not.
    const listed = seen === null ? null : this.reads.atDevices();
    if (seen !== null && listed !== null && listed.made === seen.made && listed.revoked === seen.revoked) {
      this.keep(scope, seen);
    }
  }

  /** The shell is gone: sign-out, or the account's frame taken down. What was drawn for it goes too. */
  end(): void {
    if (this.scope !== null) this.takeBack();
    this.scope = null;
    this.before = null;
    this.told = null;
  }

  /**
   * What this device has told of the account's devices. With none kept this is the device's first
   * sign-in to the account: it is the new device itself, or it learns from now. It keeps what the
   * record says and tells nothing.
   */
  private toldOf(scope: string, seen: NoticeDevices): ToldDevices {
    const kept = this.reads.told.read(scope) ?? this.told;
    if (kept !== null) return kept;
    return this.keep(scope, seen);
  }

  /**
   * THE ONE WRITER OF THE KEPT NUMBERS, called for three things only: a first sign-in learns what
   * the record says; the platform took a notice; the person stands at the Devices list that shows it. A notice
   * that was not drawn (this surface was the one being looked at, the platform refused, the answer
   * never came) keeps nothing, and the same rise is told at the next settle at which it may be
   * drawn. Never lowered: the numbers only rise.
   */
  private keep(scope: string, risen: Partial<ToldDevices>): ToldDevices {
    const kept = this.reads.told.read(scope) ?? this.told;
    const next: ToldDevices = {
      made: Math.max(kept?.made ?? 0, risen.made ?? 0),
      revoked: Math.max(kept?.revoked ?? 0, risen.revoked ?? 0),
    };
    this.told = next;
    this.reads.told.write(scope, next);
    return next;
  }

  /** Keeps `risen` once the emitter says the platform took the notice, while this account is still the one shown. */
  private keepOnceTaken(scope: string, risen: Partial<ToldDevices>, taken: NoticeTaken | void): void {
    if (taken === true) {
      this.keep(scope, risen);
      return;
    }
    if (typeof taken !== "object") return;
    void taken.then(
      (was) => {
        if (was === true && this.scope === scope) this.keep(scope, risen);
      },
      () => {
        /* An emitter never rejects; one that does took nothing. */
      },
    );
  }

  private takeBack(): void {
    try {
      this.emitter.takeBack();
    } catch {
      /* An emitter never throws; one that does takes nothing else down. */
    }
  }
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

/**
 * Mount the caller. The emitter and the reads are taken once per emitter: a shell hands in the
 * same emitter for its life, and the reads are functions read at each settle.
 */
export function useNotices(mount: NoticesMount): void {
  const { reader, version, settled, scope, emitter } = mount;
  const reads = useRef(mount.reads);
  reads.current = mount.reads;
  const caller = useRef<NoticeCaller | null>(null);

  useEffect(() => {
    if (emitter === "none") return undefined;
    const made = new NoticeCaller(emitter, {
      choices: () => reads.current.choices(),
      permission: () => reads.current.permission(),
      devices: () => reads.current.devices(),
      atDevices: () => reads.current.atDevices(),
      // Read through at each use, as the reads are: a shell may hand in new ones at a render.
      told: {
        read: (scope) => reads.current.told.read(scope),
        write: (scope, told) => reads.current.told.write(scope, told),
      },
    });
    caller.current = made;
    return () => {
      made.end();
      if (caller.current === made) caller.current = null;
    };
  }, [emitter]);

  useEffect(() => {
    if (!settled || scope === null) return;
    caller.current?.settle(scope, reader);
  }, [reader, version, settled, scope, emitter]);
}
