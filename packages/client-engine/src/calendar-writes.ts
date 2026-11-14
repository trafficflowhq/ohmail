/**
 * THE CALENDAR'S QUEUE ON A DEVICE: a person's act on an event, made durable before anything goes on
 * the wire, sent under the key minted for the press on every attempt, and let go only on our server's
 * answer. Beside the mail's outbox, on the same rule (the intent is durable the moment it is
 * expressed), and apart from it, so the mail's verbs and the phone's engine stay as they are.
 *
 * A record per act at seq 0 in the mirror: `/sync` has no word for it, so no delta
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
import {
  calendarReasonOf, calendarSettlementExpiry, refusalWordOf, writeFaultOf, type CalendarResult, type CalendarSettlement,
} from "./calendar-receipts.js";
import type { MirrorStore } from "./store.js";
import { CALENDAR_OUTBOX_TYPE, CALENDAR_SETTLEMENT_TYPE, MutationRejectedError, type SyncChange } from "./types.js";

/** The mirror's client-local type of a calendar act this device still owes our server. */
export { CALENDAR_OUTBOX_TYPE };
export { refusalWordOf, writeFaultOf, type CalendarRefusalWord } from "./calendar-receipts.js";
/** The ordinary outbox shape. Older builds do not send the deferred shape. */
export const CALENDAR_OUTBOX_VERSION = 1;

const DEFERRED_DELETE_VERSION = 2;
const ATTEMPT_MS = 15_000;
const CLAIM_MS = 30_000;
const RECEIPT_MS = 5 * 60_000;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;

type CalendarOutboxRecord = {
  readonly key: string;
  readonly act: CalendarAct;
  /** When it was pressed (the device's clock), and the session's tiebreak within one millisecond. */
  readonly at: number;
  readonly n: number;
  readonly claimedUntil?: number;
} & (
  | { readonly v: typeof CALENDAR_OUTBOX_VERSION; readonly notBefore?: never }
  | { readonly v: typeof DEFERRED_DELETE_VERSION; readonly notBefore: number }
);

/** How a device reaches our server's three write routes. The engine's HTTP adapter is one. */
export interface CalendarWriteTransport {
  /** `POST /calendar/writes` under `key`. Throws `MutationRejectedError` on a refusal. */
  writeCalendar(act: CalendarEventAct, key: string, signal?: AbortSignal): Promise<{ readonly answer: CalendarWriteAnswer; readonly seq: number | null }>;
  /** `POST /calendar/writes/:id/retry`. */
  retryCalendarWrite(writeId: string, key: string, signal?: AbortSignal): Promise<{ readonly answer: CalendarWriteAnswer; readonly seq: number | null }>;
  /** `DELETE /calendar/writes/:id`. */
  dismissCalendarWrite(writeId: string, key: string, signal?: AbortSignal): Promise<{ readonly answer: CalendarWriteAnswer; readonly seq: number | null }>;
}

/** The account-bound operations a host needs to offer the calendar. */
export interface CalendarHostTransport extends CalendarWriteTransport {
  calendarSettings(): Promise<CalendarSettingsWire>;
}

function isRecord(v: unknown): v is CalendarOutboxRecord {
  if (!v || typeof v !== "object") return false;
  const record = v as Partial<CalendarOutboxRecord>;
  if (typeof record.key !== "string" || !record.act || typeof record.act !== "object") return false;
  return record.v === CALENDAR_OUTBOX_VERSION || (record.v === DEFERRED_DELETE_VERSION &&
    record.act.kind === "calendar_event_delete" && Number.isFinite(record.notBefore));
}

const eventOf = (act: CalendarAct): string | null => ("eventId" in act ? act.eventId : null);

export class CalendarWriteQueue {
  private readonly settlements = new Map<string, { claim: number | undefined; receipt: CalendarSettlement }>();
  private readonly keys = new CalendarActKeys();
  private readonly refused = new Map<string, CalendarReason | CalendarWriteFault>();
  private n = 0;
  private sending: Promise<void> | null = null;
  private followAgain = false;
  private generation = 0;
  private wake: ReturnType<typeof setTimeout> | null = null;
  private running = true;
  private attempt: AbortController | null = null;
  private retryDelay = 0;
  private retryAt = 0;

  constructor(
    private readonly store: MirrorStore,
    private readonly transport: CalendarWriteTransport,
    private readonly opts: {
      readonly uuid: () => string;
      readonly now: () => number;
      readonly onChange?: () => void;
      readonly online?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
      readonly mayRun?: () => boolean;
    },
  ) {}

  /** What this device still owes, in the order it was pressed. */
  owed(): CalendarOutboxRecord[] {
    return this.store.entries<unknown>(CALENDAR_OUTBOX_TYPE).map((e) => e.entity).filter(isRecord)
      .sort((a, b) => a.at - b.at || a.n - b.n || (a.key < b.key ? -1 : 1));
  }

  result(key: string): CalendarResult | null {
    const receipt = this.store.get<CalendarSettlement>(CALENDAR_SETTLEMENT_TYPE, key);
    if (!receipt || calendarSettlementExpiry(receipt) <= this.opts.now()) return null;
    if (receipt.result?.kind === "taken") return { kind: "taken" };
    if (receipt.result?.kind !== "refused") return null;
    const routeWord = refusalWordOf(receipt.result.word);
    return { kind: "refused", word: routeWord === "unknown" ? writeFaultOf(receipt.result.word) : routeWord };
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
    return this.enqueue(act);
  }

  async holdDelete(act: Extract<CalendarEventAct, { kind: "calendar_event_delete" }>, delay: number) {
    const record = await this.enqueue(act, delay);
    const deadline = record.notBefore ?? record.at;
    return {
      key: record.key,
      deadline,
      remainingMs: () => Math.max(0, deadline - this.opts.now()),
      undo: () => this.undoDelete(record.key),
    };
  }

  activate(): () => void {
    this.running = true;
    this.opts.online?.addEventListener("online", this.resume);
    const unlisten = this.store.outboxNotices?.()?.listen((notice) => {
      if (notice.t === "calendar-changed") this.followDisk();
    });
    this.resume();
    return () => {
      this.running = false;
      unlisten?.();
      this.opts.online?.removeEventListener("online", this.resume);
      this.suspend();
    };
  }

  resume = (): void => {
    this.retryAt = 0;
    this.retryDelay = 0;
    this.followDisk();
  };

  private followDisk(): void {
    if (!this.mayRun()) return;
    if (this.sending !== null) this.followAgain = true;
    void this.flush();
  }

  suspend(): void {
    this.generation++;
    this.followAgain = false;
    this.clearWake();
    this.attempt?.abort();
  }

  private mayRun(): boolean {
    return this.running && (this.opts.mayRun?.() ?? true);
  }

  private async enqueue(act: CalendarAct, delay?: number) {
    if (!this.mayRun()) throw new MutationRejectedError("calendar session unavailable", { retryable: true });
    const key = this.opts.uuid();
    const at = this.opts.now();
    // A deferred deletion is stamped with the visible base. It is not a predecessor until sent.
    const stamped = delay !== undefined || act.kind === "calendar_write_retry" || act.kind === "calendar_write_dismiss"
      ? act : this.keys.stamp(act, key);
    const eventId = eventOf(stamped);
    const record: CalendarOutboxRecord = {
      key, act: stamped, at, n: this.n++,
      ...(delay === undefined ? { v: CALENDAR_OUTBOX_VERSION } :
        { v: DEFERRED_DELETE_VERSION, notBefore: at + delay }),
    };
    try {
      await this.store.commitLocal([{ type: CALENDAR_OUTBOX_TYPE, id: key, entity: record }], []);
    } catch (err) {
      if (eventId !== null) this.keys.forget(eventId, key);
      throw err;
    }
    if (eventId !== null) this.refused.delete(eventId);
    this.opts.onChange?.();
    this.followDisk();
    return record;
  }

  private async undoDelete(key: string): Promise<boolean> {
    if (!this.mayRun()) return false;
    const cancelled = await this.store.decideCalendarRow(key, (row) =>
      this.mayRun() && isRecord(row) && row.v === DEFERRED_DELETE_VERSION &&
        row.claimedUntil === undefined && this.opts.now() < row.notBefore ? null : undefined);
    this.opts.onChange?.();
    if (cancelled) this.followDisk();
    return cancelled;
  }

  /** Send in press order; a flush already under way is joined. */
  flush(): Promise<void> {
    if (this.sending !== null) return this.sending;
    this.sending = this.sendAll().catch(() => this.retry()).finally(() => {
      this.sending = null;
      if (this.followAgain) {
        this.followAgain = false;
        void this.flush();
      }
    });
    return this.sending;
  }

  private async sendAll(): Promise<void> {
    this.clearWake();
    const generation = this.generation;
    const active = () => generation === this.generation && this.mayRun();
    const shared = this.store.sharedDiskName?.() != null;
    if (!active()) return;
    if (shared && await this.store.refreshCalendarOutbox?.(this.opts.now()) && active()) this.opts.onChange?.();
    while (active()) {
      const next = this.owed()[0];
      if (!next) return;
      const delay = Math.max(next.notBefore ?? 0, this.retryAt) - this.opts.now();
      if (delay > 0) {
        this.wakeAfter(delay);
        return;
      }
      const settled = this.settlements.get(next.key);
      if (settled !== undefined) {
        // A failed local commit does not put an answered write back on the wire.
        await this.finish(next, settled.claim, settled.receipt);
        continue;
      }
      let record = next;
      let claim: number | undefined;
      if (shared || next.v === DEFERRED_DELETE_VERSION) {
        let wait = 0;
        await this.store.decideCalendarRow(next.key, (row) => {
          if (!active() || !isRecord(row)) return;
          const now = this.opts.now();
          wait = Math.max(row.notBefore ?? 0, row.claimedUntil ?? 0) - now;
          if (wait > 0) return;
          claim = now + CLAIM_MS;
          record = { ...row, claimedUntil: claim };
          return record;
        });
        if (!active()) {
          if (claim !== undefined) await this.settle(record, claim);
          return;
        }
        if (wait > 0) {
          this.wakeAfter(wait);
          return;
        }
        if (claim === undefined) {
          this.opts.onChange?.();
          continue;
        }
      }
      const sent = await this.sendOne(record, claim);
      if (!sent) {
        this.retry();
        return;
      }
      this.retryDelay = 0;
      this.retryAt = 0;
    }
  }

  private retry(): void {
    if (!this.mayRun()) return;
    this.retryDelay = Math.min(RETRY_CAP_MS, this.retryDelay ? this.retryDelay * 2 : RETRY_BASE_MS);
    this.retryAt = this.opts.now() + this.retryDelay;
    this.wakeAfter(this.retryDelay);
  }

  private wakeAfter(delay: number): void {
    this.wake = setTimeout(() => void this.flush(), delay);
  }

  private clearWake(): void {
    if (this.wake !== null) clearTimeout(this.wake);
    this.wake = null;
  }

  /**
   * Only the current claim can remove an owed write and leave its receipt. A retry only releases
   * the lease and keeps the claim mark, so moving the clock back cannot reopen Undo.
   */
  private async settle(r: CalendarOutboxRecord, claim: number | undefined, receipt?: CalendarSettlement): Promise<void> {
    if (claim === undefined) {
      if (receipt !== undefined) {
        await this.store.commitLocal([{ type: CALENDAR_SETTLEMENT_TYPE, id: r.key, entity: receipt }],
          [{ type: CALENDAR_OUTBOX_TYPE, id: r.key }]);
      }
      return;
    }
    await this.store.decideCalendarRow(r.key, (row) =>
      isRecord(row) && row.claimedUntil === claim
        ? (receipt === undefined ? { ...row, claimedUntil: 0 } : null) : undefined, receipt);
  }

  private remember(r: CalendarOutboxRecord, claim: number | undefined, result: CalendarResult): CalendarSettlement {
    const act = r.act;
    const reference = "eventId" in act
      ? { type: "event" as const, id: act.eventId }
      : { type: "write" as const, id: act.writeId };
    const receipt = { expiresAt: this.opts.now() + RECEIPT_MS, reference, result };
    this.settlements.set(r.key, { claim, receipt });
    return receipt;
  }

  private async finish(r: CalendarOutboxRecord, claim: number | undefined, receipt: CalendarSettlement): Promise<boolean> {
    await this.settle(r, claim, receipt);
    this.settlements.delete(r.key);
    this.opts.onChange?.();
    return true;
  }

  /** False leaves the original act owed and holds later acts behind it. */
  private async sendOne(r: CalendarOutboxRecord, claim: number | undefined): Promise<boolean> {
    const ctrl = new AbortController();
    this.attempt = ctrl;
    const deadline = setTimeout(() => ctrl.abort(), ATTEMPT_MS);
    let answered: { readonly answer: CalendarWriteAnswer; readonly seq: number | null };
    try {
      answered = r.act.kind === "calendar_write_retry" ? await this.transport.retryCalendarWrite(r.act.writeId, r.key, ctrl.signal)
        : r.act.kind === "calendar_write_dismiss" ? await this.transport.dismissCalendarWrite(r.act.writeId, r.key, ctrl.signal)
          : await this.transport.writeCalendar(r.act, r.key, ctrl.signal);
    } catch (err) {
      if (ctrl.signal.aborted || !this.mayRun() || !(err instanceof MutationRejectedError) || err.retryable) {
        await this.settle(r, claim);
        return false;
      }
      const word = refusalWordOf(err.code);
      const eventId = eventOf(r.act);
      if (eventId !== null) {
        this.refused.set(eventId, calendarReasonOf(word));
        this.keys.forget(eventId, r.key);
      }
      return this.finish(r, claim, this.remember(r, claim, { kind: "refused", word }));
    } finally {
      clearTimeout(deadline);
      this.attempt = null;
    }
    if (ctrl.signal.aborted || !this.mayRun()) {
      await this.settle(r, claim);
      return false;
    }
    const write = answered.answer.write;
    const receipt = this.remember(r, claim, write?.state === "refused"
      ? { kind: "refused", word: writeFaultOf(write.reason) } : { kind: "taken" });
    // Lay the answered events into the mirror before retiring the local overlay.
    const seq = answered.seq;
    if (seq !== null && answered.answer.events.length > 0) {
      await this.store.applyChanges(answered.answer.events.map((e): SyncChange => ({
        type: "calendar_event", op: "update", id: e.id, entity: e, seq, updatedAt: e.updatedAt,
      })));
    }
    return this.finish(r, claim, receipt);
  }
}
