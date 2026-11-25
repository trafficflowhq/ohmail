/**
 * THE PORT OVER ONE ENGINE: the real queue over the engine's mirror, and each press's verdict kept by its key.
 *
 * The queue records a refusal of our server's only by event; a refused retry, a refused letting go and a refused
 * create would leave no trace a person could read. So the three calls of the transport are wrapped here: an answer
 * is `taken`, a refusal that will not pass by itself is `refused` with its word and its details, and a refusal that
 * may pass (the queue keeps the act owed) is nothing yet. Verdicts live as long as the port, beside the engine.
 */
import {
  CalendarWriteQueue,
  calendarWriteMayRetry,
  refusalWordOf,
  writeFaultOf,
  type CalendarWriteTransport,
} from "@ohmail/client-engine/calendar-writes";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import { MutationRejectedError, type OhmailEngine } from "@ohmail/client-engine";
import type {
  CalendarAct,
  CalendarConnectionRecord,
  CalendarEventRecord,
  CalendarRecord,
  CalendarProposalAct,
  CalendarSettingsWire,
  CalendarWindow,
  CalendarWriteAnswer,
  CalendarWriteFault,
} from "@ohmail/wire";
import type { CalendarPort, CalendarRefusalWord, CalendarVerdict, HeldSpan } from "./port.js";

export { refusalWordOf };

type Answered = { readonly answer: CalendarWriteAnswer; readonly seq: number | null };
type LateRefusalReport = (word: CalendarRefusalWord | CalendarWriteFault) => void;

export interface PortParts {
  readonly engine: Pick<OhmailEngine, "store" | "subscribe" | "read">;
  readonly transport: CalendarWriteTransport;
  readonly online?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  readonly mayRun?: () => boolean;
  readonly clock: { readonly uuid: () => string; readonly now: () => number };
  /** `GET /calendar/settings` over the shell's transport. */
  readonly settings: () => Promise<CalendarSettingsWire>;
  readonly setup?: CalendarPort["setup"];
  readonly setSuggestionDismissed?: CalendarPort["setSuggestionDismissed"];
  /** The window our server serves and the spans this device read (the engine's public read, once it has one). */
  readonly held: () => { readonly window: CalendarWindow; readonly loaded: readonly HeldSpan[] };
  /** Reads a span before the window (`engine.loadCalendar`), or `none` where this shell cannot ask for one. */
  readonly load: CalendarPort["load"];
}

export function calendarPortOf(parts: PortParts) {
  const verdicts = new Map<string, CalendarVerdict>();
  const listeners = new Set<() => void>();
  const watched = new Set<string>();
  const reported = new Set<string>();
  const reports = new Map<LateRefusalReport, (() => void) | undefined>();
  let reporting = true;
  const retireReports = () => {
    reporting = false;
    watched.clear();
    reported.clear();
    for (const retire of reports.values()) retire?.();
    drafts.retire();
  };
  const reportSettled = () => {
    if (!reporting || reports.size === 0) return;
    for (const key of watched) {
      const result = queue.result(key);
      if (result === null) continue;
      // The frame takes ownership of the report before this key is consumed.
      if (result.kind === "refused") for (const report of reports.keys()) report(result.word);
      reported.add(key);
      watched.delete(key);
    }
  };
  const watchLateRefusal = (key: string) => {
    if (!reporting || reported.has(key)) return;
    watched.add(key);
    reportSettled();
  };
  let own = 0;
  const changed = () => {
    own += 1;
    reportSettled();
    for (const listener of [...listeners]) listener();
  };
  const transport = calendarWriteTransport(parts.transport, verdicts);
  const queue = new CalendarWriteQueue(parts.engine.store, transport, {
    uuid: parts.clock.uuid,
    now: parts.clock.now,
    onChange: changed,
    ...(parts.online ? { online: parts.online } : {}),
    ...(parts.mayRun ? { mayRun: parts.mayRun } : {}),
  });
  const verdict = verdictReader(queue, verdicts);
  const drafts = draftReportsOf(parts.engine, listeners, {
    verdict,
    events: () => queue.events(),
    changed,
    reporting: () => reporting,
  });
  const hold = async (...args: Parameters<typeof queue.hold>) => {
    const held = await queue.hold(...args);
    watchLateRefusal(held.key);
    return {
      ...held,
      async undo() {
        const undone = await held.undo();
        if (undone) watched.delete(held.key);
        return undone;
      },
    };
  };
  return {
    newId: parts.clock.uuid,
    press: (act: CalendarAct) => queue.press(act),
    holdDelete: hold,
    ...(parts.transport.mailProposal
      ? {
          holdProposal: (act: CalendarProposalAct, delay: number) => hold(act, delay),
          pendingProposals: () => queue.pendingProposals(),
        }
      : {}),
    activate() {
      reporting = true;
      const stop = queue.activate();
      return () => {
        stop();
        retireReports();
      };
    },
    resumeWrites() {
      reporting = true;
      queue.resume();
    },
    suspendWrites() {
      queue.suspend();
      retireReports();
    },
    hasOwedWrites: () => queue.owed().length > 0,
    flush: () => queue.flush(),
    verdict,
    ...drafts.port,
    watchLateRefusal,
    subscribeLateRefusals(report, retire) {
      reports.set(report, retire);
      reportSettled();
      return () => {
        reports.delete(report);
      };
    },
    settings: parts.settings,
    settingsVersion: () => parts.engine.store.stampOf("settings"),
    ...(parts.setSuggestionDismissed ? { setSuggestionDismissed: parts.setSuggestionDismissed } : {}),
    setup: parts.setup,
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
  } satisfies CalendarPort & { resumeWrites(): void; suspendWrites(): void };
}

function verdictReader(queue: CalendarWriteQueue, verdicts: ReadonlyMap<string, CalendarVerdict>) {
  return (key: string): CalendarVerdict | null => {
    const own = verdicts.get(key);
    if (own !== undefined) return own;
    const result = queue.result(key);
    if (result === null) return null;
    return result.kind === "taken" ? { kind: "taken", write: null } : { ...result, details: null };
  };
}

function draftReportsOf(
  engine: PortParts["engine"],
  listeners: Set<() => void>,
  {
    verdict,
    events: queueEvents,
    changed,
    reporting,
  }: {
    verdict: CalendarPort["verdict"];
    events: () => EventWithWrites[];
    changed: () => void;
    reporting: () => boolean;
  },
) {
  const drafts = new Map<string, () => void>();
  const refusedCreates = new Set<string>();
  const unsentCreates = new Map<string, EventWithWrites>();
  const onCalDav = (record: CalendarEventRecord) => {
    const calendar = engine.store.get<CalendarRecord>("calendar", record.calendarId);
    return (
      !!calendar &&
      engine.store.get<CalendarConnectionRecord>("calendar_connection", calendar.connectionId)?.provider ===
        "caldav"
    );
  };
  const watch = (
    eventId: string,
    key: string,
    kind: "create" | "update",
    refuse: Parameters<NonNullable<CalendarPort["watchCreate"]>>[2],
    recorded?: () => void,
  ) => {
    if (!reporting()) return;
    let wasPending = false;
    const provisional =
      kind === "create"
        ? queueEvents().find(({ record }) => record.id === eventId && onCalDav(record))?.record
        : undefined;
    const review = () => {
      const row = engine.store.get<CalendarEventRecord>("calendar_event", eventId);
      const mark = row?.writes.find((entry) => entry.key === key);
      const answer = verdict(key);
      if (recorded && (mark || (row?.uid && !row.uid.startsWith("pending:")))) {
        const confirm = recorded;
        recorded = undefined;
        confirm();
      }
      if (answer?.kind === "refused") {
        stop();
        if (kind === "create" && mark?.state === "refused" && row && !onCalDav(row))
          refusedCreates.add(eventId);
        if (!row && provisional) {
          unsentCreates.set(eventId, {
            record: provisional,
            waiting: null,
            refusal: writeFaultOf(answer.word),
            refusedWriteId: null,
          });
        }
        refuse(answer, mark?.id);
      } else if (mark?.state === "refused") {
        stop();
        if (kind === "create" && row && !onCalDav(row)) refusedCreates.add(eventId);
        refuse({ kind: "refused", word: writeFaultOf(mark.reason), details: mark }, mark.id);
      } else if (mark?.state === "pending") {
        wasPending = true;
      } else if (
        kind === "create"
          ? row?.uid && !row.uid.startsWith("pending:")
          : wasPending || (answer?.kind === "taken" && answer.write?.state !== "pending")
      ) {
        stop();
      }
    };
    const stopEngine = engine.subscribe(review);
    const stop = () => {
      listeners.delete(review);
      stopEngine();
      drafts.delete(key);
    };
    drafts.set(key, stop);
    listeners.add(review);
    review();
  };
  const port = {
    watchCreate: (eventId, key, refuse, recorded) => watch(eventId, key, "create", refuse, recorded),
    watchEdit: (eventId, key, refuse) => watch(eventId, key, "update", refuse),
    events: () => [
      ...queueEvents().filter(
        ({ record }) =>
          !refusedCreates.has(record.id) ||
          !record.writes.some(
            (mark) => mark.state === "refused" && mark.act?.kind === "calendar_event_create",
          ),
      ),
      ...unsentCreates.values(),
    ],
    forgetUnsentCreate: (eventId: string) => {
      if (unsentCreates.delete(eventId)) changed();
    },
  } satisfies Pick<CalendarPort, "watchCreate" | "watchEdit" | "forgetUnsentCreate" | "events">;
  return {
    port,
    retire: () => {
      for (const stop of drafts.values()) stop();
      refusedCreates.clear();
      unsentCreates.clear();
    },
  };
}

function calendarWriteTransport(
  transport: CalendarWriteTransport,
  verdicts: Map<string, CalendarVerdict>,
): CalendarWriteTransport {
  const keep = async (
    key: string,
    signal: AbortSignal | undefined,
    call: () => Promise<Answered>,
  ): Promise<Answered> => {
    try {
      const answered = await call();
      if (signal?.aborted) return answered;
      const write = answered.answer.write;
      verdicts.set(
        key,
        write?.state === "refused"
          ? { kind: "refused", word: writeFaultOf(write.reason), details: write }
          : { kind: "taken", write },
      );
      return answered;
    } catch (err) {
      if (!signal?.aborted && err instanceof MutationRejectedError && !calendarWriteMayRetry(err))
        verdicts.set(key, { kind: "refused", word: refusalWordOf(err.code), details: err.details });
      throw err;
    }
  };
  return {
    ...(transport.mailProposal
      ? {
          mailProposal: (act: CalendarProposalAct, key: string, signal?: AbortSignal) =>
            keep(key, signal, () => transport.mailProposal!(act, key, signal)),
        }
      : {}),
    writeCalendar: (act, key, signal) => keep(key, signal, () => transport.writeCalendar(act, key, signal)),
    retryCalendarWrite: (id, key, signal) =>
      keep(key, signal, () => transport.retryCalendarWrite(id, key, signal)),
    dismissCalendarWrite: (id, key, signal) =>
      keep(key, signal, () => transport.dismissCalendarWrite(id, key, signal)),
  };
}
