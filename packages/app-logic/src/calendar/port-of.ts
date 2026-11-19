/**
 * THE PORT OVER ONE ENGINE: the real queue over the engine's mirror, and each press's verdict kept by its key.
 *
 * The queue records a refusal of our server's only by event; a refused retry, a refused letting go and a refused
 * create would leave no trace a person could read. So the three calls of the transport are wrapped here: an answer
 * is `taken`, a refusal that will not pass by itself is `refused` with its word and its details, and a refusal that
 * may pass (the queue keeps the act owed) is nothing yet. Verdicts live as long as the port, beside the engine.
 */
import { CalendarWriteQueue, type CalendarWriteTransport } from "@ohmail/client-engine/calendar-writes";
import { MutationRejectedError, type OhmailEngine } from "@ohmail/client-engine";
import type { CalendarAct, CalendarSettingsWire, CalendarWindow, CalendarWriteAnswer } from "@ohmail/wire";
import type { CalendarPort, CalendarRefusalWord, CalendarVerdict, HeldSpan } from "./port.js";

/** The words our server's write routes refuse with; anything else is `unknown`, never shown as it came. */
const WORDS: ReadonlySet<string> = new Set<CalendarRefusalWord>([
  "calendar_off",
  "calendar_read_only",
  "calendar_writes_full",
  "calendar_write_left",
  "calendar_connection_stopped",
  "validation_failed",
  "not_found",
  "payload_too_large",
  "idempotency_replay",
]);

export const refusalWordOf = (code: string | null): CalendarRefusalWord =>
  code !== null && WORDS.has(code) ? (code as CalendarRefusalWord) : "unknown";

type Answered = { readonly answer: CalendarWriteAnswer; readonly seq: number | null };

export interface PortParts {
  readonly engine: Pick<OhmailEngine, "store" | "subscribe" | "read">;
  readonly transport: CalendarWriteTransport;
  readonly clock: { readonly uuid: () => string; readonly now: () => number };
  /** `GET /calendar/settings` over the shell's transport. */
  readonly settings: () => Promise<CalendarSettingsWire>;
  /** The window our server serves and the spans this device read (the engine's public read, once it has one). */
  readonly held: () => { readonly window: CalendarWindow; readonly loaded: readonly HeldSpan[] };
  /** Reads a span before the window (`engine.loadCalendar`), or `none` where this shell cannot ask for one. */
  readonly load: CalendarPort["load"];
}

export function calendarPortOf(parts: PortParts): CalendarPort {
  const verdicts = new Map<string, CalendarVerdict>();
  const listeners = new Set<() => void>();
  let own = 0;
  const changed = () => {
    own += 1;
    for (const listener of [...listeners]) listener();
  };
  const keep = async (key: string, call: () => Promise<Answered>): Promise<Answered> => {
    try {
      const answered = await call();
      const write = answered.answer.write;
      verdicts.set(
        key,
        write?.state === "refused"
          ? { kind: "refused", word: write.reason ?? "unknown", details: write }
          : { kind: "taken", write },
      );
      return answered;
    } catch (err) {
      if (err instanceof MutationRejectedError && !err.retryable)
        verdicts.set(key, { kind: "refused", word: refusalWordOf(err.code), details: err.details });
      throw err;
    }
  };
  const transport: CalendarWriteTransport = {
    writeCalendar: (act, key) => keep(key, () => parts.transport.writeCalendar(act, key)),
    retryCalendarWrite: (id, key) => keep(key, () => parts.transport.retryCalendarWrite(id, key)),
    dismissCalendarWrite: (id, key) => keep(key, () => parts.transport.dismissCalendarWrite(id, key)),
  };
  const queue = new CalendarWriteQueue(parts.engine.store, transport, {
    uuid: parts.clock.uuid,
    now: parts.clock.now,
    onChange: changed,
  });
  return {
    newId: parts.clock.uuid,
    press: (act: CalendarAct) => queue.press(act),
    flush: () => queue.flush(),
    verdict: (key) => verdicts.get(key) ?? null,
    events: () => queue.events(),
    settings: parts.settings,
    held: parts.held,
    load: parts.load,
    version: () => parts.engine.read().version() * 1_000_003 + own,
    subscribe(listener) {
      listeners.add(listener);
      const off = parts.engine.subscribe(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
  };
}
