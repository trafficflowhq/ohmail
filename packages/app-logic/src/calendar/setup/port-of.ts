import { MutationRejectedError } from "@ohmail/client-engine";
import type { CalendarSetupTransport } from "@ohmail/client-engine";
import { CONNECT_FAULT_KEYS } from "./faults.js";
import type { CalendarSyncFault } from "@ohmail/wire";
import type { CalendarSetupPort, ConnectAnswer } from "./port.js";

async function connect(call: () => Promise<unknown>, refresh: () => void): Promise<ConnectAnswer> {
  try {
    await call();
  } catch (error) {
    if (!(error instanceof MutationRejectedError)) throw error;
    if (error.status === 403 && error.code === "step_up_required") return { kind: "step_up" };
    const fault = (error.details as { fault?: unknown } | null)?.fault;
    if (typeof fault !== "string" || !Object.hasOwn(CONNECT_FAULT_KEYS, fault)) throw error;
    return { kind: "refused", fault: fault as CalendarSyncFault };
  }
  refresh();
  return { kind: "taken" };
}

/** The setup issues direct requests through the same account-bound transport as the calendar's reads. */
export function calendarSetupPortOf(
  transport: CalendarSetupTransport,
  sync: () => Promise<void>,
  uuid: () => string,
): CalendarSetupPort {
  const {
    calendarConnections,
    icloudMailboxes,
    linkedMailboxIds,
    saveCalendarSettings: saveSettings,
  } = transport;
  const refresh = () => {
    void sync().catch(() => undefined);
  };
  return {
    ways: () => transport.calendarWays(),
    ...(calendarConnections ? { hasConnections: async () => (await calendarConnections()).length > 0 } : {}),
    ...(icloudMailboxes ? { icloudMailboxes } : {}),
    ...(linkedMailboxIds ? { linkedMailboxIds } : {}),
    connect: (ask) =>
      connect(
        () => transport.connectCalendar(ask, "fromMailbox" in ask ? ask.connectionId : uuid()),
        refresh,
      ),
    signInAgain: (ask) =>
      connect(
        () =>
          transport.signInCalendarAgain(
            ask.connectionId,
            ask.way === "ics" ? { address: ask.address } : { user: ask.user, password: ask.password },
          ),
        refresh,
      ),
    remove: async (id) => {
      let accepted = false;
      try {
        while (!(await transport.removeCalendarConnection(id)).removed) {
          accepted = true;
        }
      } catch (error) {
        // The worker can finish a removal before the next request arrives.
        if (
          !accepted ||
          !(error instanceof MutationRejectedError) ||
          error.status !== 404 ||
          error.code !== "not_found"
        )
          throw error;
      } finally {
        refresh();
      }
    },
    check: async (id, calendarId) => {
      await transport.checkCalendarConnection(id, calendarId);
      refresh();
    },
    setCalendar: async (id, change) => {
      await transport.setCalendar(id, change);
      refresh();
    },
    saveSettings: saveSettings
      ? async (body) => {
          const saved = await saveSettings(body);
          refresh();
          return saved;
        }
      : "none",
  };
}
