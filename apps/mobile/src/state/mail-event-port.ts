import { calendarId } from "./mail-event-id";
import { calendarPortOf } from "@ohmail/app-logic/calendar";
import type { ConnectedSession } from "../net/pairing";

const currentPorts = new WeakMap<ConnectedSession, ReturnType<typeof calendarPortOf>>();

export function mailEventPort(session: ConnectedSession | null) {
  if (!session || session.standalone) return null;
  const held = currentPorts.get(session);
  if (held) return held;
  const engine = session.engine;
  const transport = engine?.calendarTransport();
  if (!transport) return null;
  const port = calendarPortOf({
    engine, transport, settings: transport.calendarSettings,
    ...(transport.setSuggestionDismissed ? { setSuggestionDismissed: transport.setSuggestionDismissed } : {}),
    clock: { uuid: calendarId, now: Date.now },
    mayRun: () => engine.calendarQueueReady(),
    held: () => engine.calendarHeld(),
    load: (span) => engine.loadCalendar(span),
  });
  currentPorts.set(session, port);
  return port;
}
