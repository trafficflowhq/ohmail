/**
 * THE CALENDAR'S QUEUE ON A DEVICE: a person's act on an event, made durable before anything goes on
 * the wire, sent under the key minted for the press on every attempt, and let go only on our server's
 * answer. Beside the mail's outbox, on the same rule (the intent is durable the moment it is
 * expressed), and apart from it, so the mail's verbs and the phone's engine stay as they are.
 *
 * A record per act at seq 0 in the mirror (`putLocal`): `/sync` has no word for it, so no delta
 * contradicts it and the windowed prune never takes it. A reload reads the records back and sends
 * them again, in the order they were pressed, under their own keys: our server makes one row of
 * one key, whatever arrives twice.
 *
 * Our server's answer carries the records of the events the act touched, each with its writes, and
 * they are laid into the mirror at once (read-your-writes), so a view passes from this queue's own
 * act to the record's mark without a gap. A refusal of our server's ends the act and is said beside
 * its event until the person acts on the event again.
 */
import type {
  CalendarAct, CalendarEventAct, CalendarEventRecord, CalendarReason, CalendarSettingsWire, CalendarWriteAnswer, CalendarWriteFault,
} from "@ohmail/wire";
import { CalendarActKeys, eventsWithWrites, type DeviceAct, type EventWithWrites } from "./calendar-acts.js";
import type { MirrorStore } from "./store.js";
import { MutationRejectedError, type SyncChange } from "./types.js";

/** The mirror's client-local type of a calendar act this device still owes our server. */
export const CALENDAR_OUTBOX_TYPE = "calendar_outbox";
/** The shape this build writes; a record of another is left where it is, never sent. */
export const CALENDAR_OUTBOX_VERSION = 1;

interface CalendarOutboxRecord {
  readonly v: typeof CALENDAR_OUTBOX_VERSION;
  readonly key: string;
  readonly act: CalendarAct;
  /** When it was pressed (the device's clock), and the session's tiebreak within one millisecond. */
  readonly at: number;
  readonly n: number;
}

/** How a device reaches our server's three write routes. The engine's HTTP adapter is one. */
export interface CalendarWriteTransport {
  /** `POST /calendar/writes` under `key`. Throws `MutationRejectedError` on a refusal. */
  writeCalendar(act: CalendarEventAct, key: string): Promise<{ readonly answer: CalendarWriteAnswer; readonly seq: number | null }>;
  /** `POST /calendar/writes/:id/retry`. */
  retryCalendarWrite(writeId: string, key: string): Promise<{ readonly answer: CalendarWriteAnswer; readonly seq: number | null }>;
  /** `DELETE /calendar/writes/:id`. */
  dismissCalendarWrite(writeId: string, key: string): Promise<{ readonly answer: CalendarWriteAnswer; readonly seq: number | null }>;
}

/** The account-bound operations a host needs to offer the calendar. */
export interface CalendarHostTransport extends CalendarWriteTransport {
  calendarSettings(): Promise<CalendarSettingsWire>;
}

const isRecord = (v: unknown): v is CalendarOutboxRecord =>
  typeof v === "object" && v !== null && (v as { v?: unknown }).v === CALENDAR_OUTBOX_VERSION
  && typeof (v as { key?: unknown }).key === "string" && typeof (v as { act?: unknown }).act === "object" && (v as { act?: unknown }).act !== null;

const eventOf = (act: CalendarAct): string | null => ("eventId" in act ? act.eventId : null);

export class CalendarWriteQueue {
  private readonly keys = new CalendarActKeys();
  private readonly refused = new Map<string, CalendarReason | CalendarWriteFault>();
  private n = 0;
  private sending: Promise<void> | null = null;

  constructor(
    private readonly store: MirrorStore,
    private readonly transport: CalendarWriteTransport,
    private readonly opts: { readonly uuid: () => string; readonly now: () => number; readonly onChange?: () => void },
  ) {}

  /** What this device still owes, in the order it was pressed. */
  owed(): CalendarOutboxRecord[] {
    return this.store.entries<unknown>(CALENDAR_OUTBOX_TYPE).map((e) => e.entity).filter(isRecord)
      .sort((a, b) => a.at - b.at || a.n - b.n || (a.key < b.key ? -1 : 1));
  }

  /** The acts on events this device still owes, for the overlay. */
  deviceActs(): DeviceAct[] {
    return this.owed().flatMap((r) => (r.act.kind === "calendar_write_retry" || r.act.kind === "calendar_write_dismiss" ? [] : [{ key: r.key, act: r.act }]));
  }

  /** Every event the mirror holds, with what waits for it and where. */
  events(): EventWithWrites[] {
    const records = this.store.entries<CalendarEventRecord | null>("calendar_event").map((e) => e.entity).filter((e): e is CalendarEventRecord => e !== null);
    return eventsWithWrites(records, this.deviceActs(), this.refused);
  }

  /**
   * A person's act, pressed: its key minted, `after` set where this session acted on the event
   * before, the record written durably, and only then sent. Answers the key it rides under.
   */
  async press(act: CalendarAct): Promise<{ readonly key: string }> {
    const key = this.opts.uuid();
    const stamped: CalendarAct = act.kind === "calendar_write_retry" || act.kind === "calendar_write_dismiss" ? act : this.keys.stamp(act, key);
    const eventId = eventOf(stamped);
    if (eventId !== null) this.refused.delete(eventId);
    const record: CalendarOutboxRecord = { v: CALENDAR_OUTBOX_VERSION, key, act: stamped, at: this.opts.now(), n: this.n++ };
    await this.store.putLocal(CALENDAR_OUTBOX_TYPE, key, record);
    this.opts.onChange?.();
    void this.flush();
    return { key };
  }

  /**
   * Send what is owed, one act at a time in the order pressed; a send already under way is joined.
   * An act our server could not take now stays owed for the next flush; the rest are let go.
   */
  flush(): Promise<void> {
    if (this.sending !== null) return this.sending;
    this.sending = this.sendAll().finally(() => { this.sending = null; });
    return this.sending;
  }

  /** Every owed act, and the ones pressed while it sent; each answered act leaves the queue, so this ends. */
  private async sendAll(): Promise<void> {
    for (let owed = this.owed(); owed.length > 0; owed = this.owed()) {
      for (const record of owed) {
        if (!await this.sendOne(record)) return;
      }
    }
  }

  /** `false`: our server could not take it now, and nothing behind it is sent before it. */
  private async sendOne(r: CalendarOutboxRecord): Promise<boolean> {
    let answered: { readonly answer: CalendarWriteAnswer; readonly seq: number | null };
    try {
      answered = r.act.kind === "calendar_write_retry" ? await this.transport.retryCalendarWrite(r.act.writeId, r.key)
        : r.act.kind === "calendar_write_dismiss" ? await this.transport.dismissCalendarWrite(r.act.writeId, r.key)
          : await this.transport.writeCalendar(r.act, r.key);
    } catch (err) {
      if (!(err instanceof MutationRejectedError) || err.retryable) return false;
      const eventId = eventOf(r.act);
      if (eventId !== null) {
        this.refused.set(eventId, (err.code ?? "unknown") as CalendarReason);
        this.keys.forget(eventId, r.key);
      }
      await this.store.putLocal(CALENDAR_OUTBOX_TYPE, r.key, null);
      this.opts.onChange?.();
      return true;
    }
    // The records the act touched, as our server holds them now, at the seq of the change it recorded: laid in
    // before the act is let go. A key our server had already recorded names no new change; the feed brings that.
    const seq = answered.seq;
    if (seq !== null && answered.answer.events.length > 0) {
      await this.store.applyChanges(answered.answer.events.map((e): SyncChange => ({
        type: "calendar_event", op: "update", id: e.id, entity: e, seq, updatedAt: e.updatedAt,
      })));
    }
    await this.store.putLocal(CALENDAR_OUTBOX_TYPE, r.key, null);
    this.opts.onChange?.();
    return true;
  }
}
