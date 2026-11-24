/** One caller per surface. A scope transition clears the previous sample and scheduled notices. */
import type { EngineMessage } from "@ohmail/wire";
import { useEffect, useRef } from "react";
import {
  AlertBook,
  aheadSet,
  decideNotices,
  cleanNoticeText,
  dueNotice,
  mayDrawKind,
  mayPost,
  noticeSampleOf,
  type AheadSet,
  type EntityReader,
  type NoticeDevices,
  type NoticeSample,
  type Notice,
  type NoticeAhead,
  type NoticeTaken,
} from "@ohmail/client-engine";
import { CalendarSummary } from "./calendar-summary.js";
import { mayDeliver, singleArrival } from "./notice-delivery.js";
import type { HostNoticeEmitter, NoticeReads, NoticesMount } from "./notice-reads.js";
import type { ToldDevices } from "./told-devices.js";

export { devicesListedOf, showDevicesListed } from "./devices-listed.js";

export {
  TOLD_DEVICES_PREFIX,
  toldDevicesIn,
  toldDevicesKey,
  type ToldDevices,
  type ToldDevicesStore,
} from "./told-devices.js";

export {
  noticeReadsOf,
  type CalendarReads,
  type HostNoticeEmitter,
  type NoticeReads,
  type NoticesMount,
} from "./notice-reads.js";

/**
 * The caller without React: what the hook below runs, and what a test drives. `settle` is one
 * settle of the copy under `scope`; `end` is the shell going away.
 */
export class NoticeCaller {
  private scope: string | null = null;
  private before: ReturnType<typeof noticeSampleOf> | null = null;
  /** What was last kept for this scope, for a device whose storage keeps nothing: the app's life then. */
  private told: ToldDevices | null = null;
  /** The alerts this caller rings itself, where its surface cannot set them. */
  private readonly book = new AlertBook();
  private nativeAlertsSet = false;
  private calendarTurn = 0;
  private readonly summary: CalendarSummary;

  constructor(
    private readonly emitter: HostNoticeEmitter,
    private readonly reads: NoticeReads,
  ) {
    this.summary = new CalendarSummary(emitter, reads);
  }

  /** One settle of the copy `reader` shows for the account `scope`, at `nowMs`. */
  settle(scope: string, reader: EntityReader, nowMs: number = Date.now()): void {
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
    const calendar = this.reads.calendar;
    let changes = null;
    if (calendar !== "none" && calendar.liveScope() === scope) {
      try {
        changes = calendar.changes(this.before?.calendar ?? null, nowMs);
      } catch {
        // A partial calendar cannot supply either side of the next comparison.
      }
    }
    const after = noticeSampleOf(reader, seen, changes?.sample ?? null);
    // Mail is compared with the sample before; the first sample with itself, so nothing of it is
    // an event. The devices are compared with what this device has told, at the first sample too.
    const previous = this.before ?? after;
    const before: NoticeSample = {
      ...previous,
      devices:
        seen === null || told === null ? null : { made: told.made, revoked: told.revoked, live: seen.live },
    };
    this.before = after;
    const choices = this.reads.choices();
    const answer = decideNotices(
      before,
      after,
      choices,
      this.reads.permission(),
      this.emitter.carries,
      changes?.look,
    );
    for (const notice of answer) {
      const letter =
        notice.kind === "ohbox" && notice.count === 1
          ? singleArrival(previous.unreadIds, after.unreadIds)
          : undefined;
      const message =
        letter !== undefined && choices.showMailDetails === true
          ? reader.get<EngineMessage>("message", letter)
          : undefined;
      const sender = message?.from ? cleanNoticeText(message.from.name || message.from.address) : null;
      const subject = message ? cleanNoticeText(message.subject) : null;
      const current = this.deliveryGuard(notice, scope, before);
      const taken =
        sender && subject
          ? this.emitter.post(
              notice,
              () => current() && this.reads.choices().showMailDetails === true,
              letter,
              { sender, subject },
            )
          : this.emitter.post(notice, current, letter);
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
    this.setAhead(scope, nowMs);
    this.scheduleSummary(scope, nowMs);
    this.postDue(nowMs);
  }

  /** The minute this caller must be woken at for its next alert; `null` while none waits. */
  nextAtMs(): number | null {
    const alert = this.book.nextAtMs();
    if (alert === null) return this.summary.nextAtMs;
    return this.summary.nextAtMs === null ? alert : Math.min(alert, this.summary.nextAtMs);
  }

  ring(nowMs: number = Date.now()): void {
    if (this.scope === null || this.nextAtMs() === null) return;
    this.setAhead(this.scope, nowMs);
    this.scheduleSummary(this.scope, nowMs);
    this.postDue(nowMs);
  }

  private scheduleSummary(scope: string, nowMs: number): void {
    const turn = this.calendarTurn;
    this.summary.settle(
      scope,
      nowMs,
      () => this.scope === scope && this.calendarTurn === turn,
      (notice, guard, details) => this.emitter.post(notice, guard, undefined, undefined, details),
    );
  }

  private postDue(nowMs: number): void {
    const calendar = this.reads.calendar;
    if (calendar === "none") return;
    const live = calendar.liveScope();
    if (live !== this.scope && this.before !== null) this.before = { ...this.before, calendar: null };
    for (const alert of this.book.due(live, nowMs)) {
      try {
        const at = calendar.clock(alert.startMs, nowMs);
        const notice = at === null ? null : dueNotice(alert, at, this.emitter.acts);
        if (notice === null) continue;
        if (mayPost(notice, this.reads.choices(), this.reads.permission(), this.emitter.carries))
          this.emitter.post(notice, this.deliveryGuard(notice, live, null, alert));
      } catch {
        /* An alert that cannot be drawn takes nothing down, and is not asked for again. */
      }
    }
  }

  /** The browser may need to wait for its worker registration before it can submit. */
  private deliveryGuard(
    notice: Notice,
    scope: string | null,
    before: NoticeSample | null,
    alert?: NoticeAhead,
  ): () => boolean {
    const turn = this.calendarTurn;
    return () => {
      return (
        scope !== null &&
        this.scope === scope &&
        mayDeliver({
          notice,
          scope,
          before,
          alert,
          reads: this.reads,
          carries: this.emitter.carries,
          calendarCurrent: turn === this.calendarTurn,
        })
      );
    };
  }

  /** A catch-up can change the calendar under a scheduled alert. Seed again when it settles. */
  suspendCalendar(nowMs = Date.now()): void {
    this.calendarTurn++;
    this.summary.nextAtMs = null;
    if (this.before !== null) this.before = { ...this.before, calendar: null };
    const empty = this.scope === null ? null : aheadSet(this.scope, [], nowMs);
    if (empty === null) this.book.clear();
    else this.book.set(empty);
    this.withdrawNative(nowMs);
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

  private setAhead(scope: string, nowMs: number): void {
    const calendar = this.reads.calendar;
    if (calendar === "none") {
      this.suspendCalendar(nowMs);
      return;
    }
    let handed: AheadSet | null = null;
    try {
      const rings = mayDrawKind(
        "cal_alert",
        this.reads.choices(),
        this.reads.permission(),
        this.emitter.carries,
      );
      const wanted = rings && calendar.liveScope() === scope ? calendar.ahead(scope, nowMs) : null;
      handed = wanted !== null && wanted.scope === scope ? wanted : aheadSet(scope, [], nowMs);
    } catch {
      handed = aheadSet(scope, [], nowMs);
    }
    if (handed === null) {
      // No account's scope, or the calendar could not be read: nothing new is set, and nothing held rings on.
      this.book.clear();
      return;
    }
    if (this.emitter.ahead === "none") {
      this.book.set(handed);
      return;
    }
    try {
      this.emitter.ahead(handed);
      this.nativeAlertsSet = handed.alerts.length > 0;
    } catch {
      /* An emitter never throws; one that does takes nothing else down. */
    }
  }

  private withdrawNative(nowMs: number): void {
    if (!this.nativeAlertsSet || this.scope === null || this.emitter.ahead === "none") return;
    const empty = aheadSet(this.scope, [], nowMs);
    if (empty === null) return;
    try {
      this.emitter.ahead(empty);
      this.nativeAlertsSet = false;
    } catch {
      /* Retry at the next settle if the surface could not take the withdrawal. */
    }
  }

  private takeBack(): void {
    this.calendarTurn++;
    this.summary.reset();
    this.nativeAlertsSet = false;
    this.book.clear();
    try {
      this.emitter.takeBack();
    } catch {
      /* An emitter never throws; one that does takes nothing else down. */
    }
  }
}

/** The longest a timer is set for: past it the wake finds nothing due and sets the next. */
const WAKE_MAX_MS = 2_147_483_647;

/**
 * Mount the caller. The emitter and the reads are taken once per emitter: a shell hands in the
 * same emitter for its life, and the reads are functions read at each settle.
 */
export function useNotices(mount: NoticesMount): void {
  const { reader, version, settled, scope, emitter } = mount;
  const calendarScope = mount.reads.calendar === "none" ? null : mount.reads.calendar.liveScope();
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
      get calendar() {
        return reads.current.calendar;
      },
    });
    caller.current = made;
    return () => {
      made.end();
      if (caller.current === made) caller.current = null;
    };
  }, [emitter]);

  useEffect(() => {
    const made = caller.current;
    if (made === null) return undefined;
    if (scope === null) {
      made.end();
      return undefined;
    }
    if (!settled) {
      made.suspendCalendar();
      return undefined;
    }
    made.settle(scope, reader);
    // Wake at the next alert's minute, with nothing else moving; each wake sets the one after it.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      const at = made.nextAtMs();
      if (at === null) return;
      timer = setTimeout(
        () => {
          timer = null;
          made.ring();
          arm();
        },
        Math.min(Math.max(at - Date.now(), 0), WAKE_MAX_MS),
      );
    };
    arm();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [reader, version, settled, scope, emitter, calendarScope]);
}
