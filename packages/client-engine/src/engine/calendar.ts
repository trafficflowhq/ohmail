/**
 * THE CALENDAR'S SIDE OF THE ENGINE: the account's switch followed, and a span loaded on purpose.
 *
 * The feed sends calendar records only while the account's switch is on; a change made while it is
 * off never comes. So the engine follows the switch on the settings record it holds
 * (`calendarEnabledAt`), as a STATE kept in the mirror's meta, never as an edge in one engine's
 * memory: the instant the calendar was last read whole for. At a drain's settle the held switch is
 * compared with it: on at an instant not read for, the engine lets whatever it held go and reads
 * the calendar as it stands (the snapshot's calendar phase alone, rows only, the delta's cursor
 * untouched); off, it lets every calendar record go. A read cut short (a page refused, a reload, a
 * crash, a phone gone offline) is owed until one finishes, in the next engine over the mirror too.
 * A first load that served the calendar's phase is a read whole for the switch it brought.
 *
 * `loadCalendar(span)` reads a span besides the window (earlier days a view asks for) and keeps it:
 * the prune holds what a loaded span covers. Which spans to ask for, and when to let them go, is
 * the views' to decide.
 */
import type { Assert, CalendarRecordKind, CalendarWindow, Complete, PlaceSuggestBody, SyncSnapshotPage } from "@ohmail/wire";
import { askPlaces, type PlaceSuggestOutcome, type PlaceSuggestTransport } from "../place-suggest.js";
import type { CalendarSetupAdapter, CalendarSetupTransport } from "../calendar-connect.js";
import type { CalendarHostTransport } from "../calendar-writes.js";
import type { SyncChange } from "../types.js";
import type { CalendarSpan } from "./calendar-span.js";
import { EngineLifecycle } from "./lifecycle.js";

/** The calendar's record kinds as this engine stores them. */
export const CALENDAR_KINDS = [
  "calendar_connection", "calendar", "calendar_event", "calendar_suggestion",
] as const satisfies readonly CalendarRecordKind[];
type _CalendarKindsComplete = Assert<Complete<CalendarRecordKind, typeof CALENDAR_KINDS>>;

/**
 * The mirror's meta key: the switch instant the calendar was last read whole for, `null` once it
 * was let go. Absent on a mirror no engine of this build settled yet, which owes the comparison.
 */
export const CALENDAR_READ_FOR_META = "calendarReadFor";

/** The switch a settings record states: the instant it went on, or null while it is off or unsaid. */
function switchOf(entity: unknown): string | null {
  const at = (entity as { calendarEnabledAt?: unknown } | null | undefined)?.calendarEnabledAt;
  return typeof at === "string" && at !== "" ? at : null;
}

export abstract class EngineCalendar extends EngineLifecycle {
  /** Whether the account's local calendar intents have finished loading. */
  calendarQueueReady(): boolean {
    return this.outboxLoadable();
  }

  /** The calendar doors this engine actually received, including the browser's account guard. */
  calendarTransport(): CalendarHostTransport | null {
    const adapter = this.adapter as Partial<CalendarHostTransport>;
    if (!adapter.calendarSettings || !adapter.writeCalendar || !adapter.retryCalendarWrite || !adapter.dismissCalendarWrite) return null;
    return {
      calendarSettings: adapter.calendarSettings.bind(adapter),
      writeCalendar: adapter.writeCalendar.bind(adapter),
      retryCalendarWrite: adapter.retryCalendarWrite.bind(adapter),
      dismissCalendarWrite: adapter.dismissCalendarWrite.bind(adapter),
      ...(adapter.setSuggestionDismissed ? {
        setSuggestionDismissed: async (id: string, dismissed: boolean) => {
          await adapter.setSuggestionDismissed!(id, dismissed);
          // A drain already in flight may have read before the change committed.
          await this.syncFresh().catch(() => { /* the next scheduled drain catches up */ });
        },
      } : {}),
    };
  }

  calendarSetupTransport(): CalendarSetupTransport | null {
    return (this.adapter as Partial<CalendarSetupAdapter>).calendarSetupTransport?.() ?? null;
  }

  /** The served window and the additional spans this mirror has actually read. */
  calendarHeld(): { window: CalendarWindow; loaded: readonly CalendarSpan[] } {
    return { window: this.calendarWindow, loaded: this.calendarLoaded };
  }

  /** The switch the held settings record states, kept from the pages; `undefined` until read once. */
  private heldSwitch: string | null | undefined;

  /**
   * PLACE SUGGESTIONS for an event's place field (`place-suggest.ts`): one question to the account's
   * server, given up through `signal`, never asked offline, never queued, never kept. Never rejects;
   * every state but `ok` is no suggestions. A server that does not offer them is never asked: its
   * `/hello` says so, and the field reads that first.
   */
  suggestPlaces(question: PlaceSuggestBody, opts: { signal?: AbortSignal } = {}): Promise<PlaceSuggestOutcome> {
    const transport = this.adapter as Partial<PlaceSuggestTransport>;
    return askPlaces(typeof transport.suggestPlaces === "function" ? (transport as PlaceSuggestTransport) : null, question, opts);
  }

  /**
   * Read before a page lands: the switch its last settings record states. A page that carries no
   * settings record reads nothing, so an idle drain stays free.
   */
  protected noteCalendarSwitch(changes: SyncChange[]): void {
    for (const ch of changes) {
      if (ch.type === "settings" && ch.op !== "delete") this.heldSwitch = switchOf(ch.entity);
    }
  }

  /** The held switch, read off the mirror once per engine and then kept from the pages. */
  private switchHeld(): string | null {
    if (this.heldSwitch === undefined) this.heldSwitch = switchOf(this.store.entries("settings")[0]?.entity);
    return this.heldSwitch;
  }

  /** At a first load's end: it read the calendar whole for the switch it brought, or read none. */
  protected async noteCalendarRead(served: boolean): Promise<void> {
    await this.store.setMeta(CALENDAR_READ_FOR_META, served ? this.switchHeld() : null);
  }

  /**
   * At a drain's settle: the held switch against the one the calendar was last read whole for.
   * Equal, nothing, so an idle drain asks nothing. Off, every calendar record goes. On at an
   * instant not read for, what was held goes and the calendar is read as it stands; a read that does
   * not finish leaves it owed, to the next settle and to the next engine over this mirror. Where no
   * first load can be read (no snapshot route), the delta is the only road: nothing is let go for a
   * read that cannot follow.
   */
  protected async settleCalendarSwitch(): Promise<void> {
    const want = this.switchHeld();
    const readFor = this.store.getMeta<string | null>(CALENDAR_READ_FOR_META);
    if (readFor !== undefined && readFor === want) return;
    if (want === null) {
      await this.dropCalendar();
      await this.store.setMeta(CALENDAR_READ_FOR_META, null);
      return;
    }
    if (!this.snapshotFn || this.snapshotUnavailable) return;
    await this.dropCalendar();
    if (await this.loadCalendar()) await this.store.setMeta(CALENDAR_READ_FOR_META, want);
  }

  /** Every calendar record lets go, as a prune does: the server still has them, nothing is a deletion. */
  private async dropCalendar(): Promise<void> {
    const victims = CALENDAR_KINDS.flatMap((type) => this.store.entries(type).map((r) => ({ type, id: r.id })));
    this.calendarLoaded = [];
    if (victims.length === 0) return;
    await this.store.prune(victims);
    this.notify();
  }

  /**
   * READ THE CALENDAR AS IT STANDS: the window around today, or `span` besides it, which the prune
   * then keeps. Rows only, at the snapshot's own seq; the delta's cursor never moves on it. True
   * when the read finished, or the server serves this account no calendar (nothing to read); false
   * when a page failed, and nothing that landed is undone.
   */
  async loadCalendar(span?: { from: Date | string; to: Date | string }): Promise<boolean> {
    const snapshot = this.snapshotFn;
    if (!snapshot || this.snapshotUnavailable) return false;
    const named = span === undefined
      ? undefined
      : { from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString() };
    let cursor: string | undefined;
    let wrote = false;
    for (;;) {
      let page: SyncSnapshotPage;
      try {
        page = await this.readCeiling(snapshot({
          phase: "calendar",
          ...(this.types ? { types: this.types } : {}),
          ...(cursor !== undefined ? { cursor } : (named ?? {})),
        }));
      } catch {
        if (wrote) this.notify();
        return false;
      }
      // A page that states no calendar span is not the calendar's phase: none is served here.
      if (page.calendarWindow === undefined) break;
      this.calendarWindow = page.calendarWindow;
      if (page.changes.length > 0) {
        this.noteApplied(page.changes);
        await this.store.applyChanges(page.changes);
        wrote = true;
      }
      if (page.nextCursor == null || page.nextCursor === "") {
        if (named) this.calendarLoaded.push({ fromMs: Date.parse(named.from), toMs: Date.parse(named.to) });
        break;
      }
      cursor = page.nextCursor;
    }
    if (wrote) this.notify();
    return true;
  }
}
