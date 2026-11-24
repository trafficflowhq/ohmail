import type { NoticeAct, OhmailEngine } from "@ohmail/client-engine";
import type { CalendarRecord, CalendarSuggestionRecord } from "@ohmail/wire";
import { useSyncStatus } from "../../engine/context.js";
import type { CalendarReads } from "../../notices/use-notices.js";
import { readerZone } from "../../reader/head-model.js";
import { sessionIsDead, useSessionDead } from "../../session/session-truth.js";
import { syncIdentityOf } from "../../session/sync-scheduler.js";
import type { CalendarPort } from "../port.js";
import { readerZones } from "../spans/days.js";
import { calendarReadsOf } from "./reads.js";

type CalendarSession = {
  readonly scope: string | null;
  readonly state: "live" | "refused" | "none";
  readonly liveNoticeScope?: () => string | null;
};

/** Read again when an alert fires. The web confirms its named mirror and the desktop names its served mailbox. */
export function liveCalendarScope(engine: OhmailEngine, session: CalendarSession): string | null {
  if (session.scope === null || session.state === "refused" || sessionIsDead()) return null;
  // Observe marker changes even when the marker names another account: returning to the old
  // marker still needs a fresh confirmation from the server.
  const identity = syncIdentityOf(engine);
  return identity === "holds" && session.liveNoticeScope?.() === session.scope ? session.scope : null;
}

interface CalendarNoticeHost {
  readonly engine: OhmailEngine;
  readonly wires: { readonly calendar: CalendarPort | "none" };
  readonly session: Pick<CalendarSession, "scope" | "state">;
  readonly device: { readonly notifications: Pick<CalendarSession, "liveNoticeScope"> | "none" };
}

/** Both mail shells read the port's presented events and the same engine's records, only after its first drain. */
export function useHostCalendarNotices(
  host: CalendarNoticeHost,
  ownAddresses: readonly string[] | null,
  showTitles: () => boolean,
  acts: readonly NoticeAct[],
): CalendarReads | undefined {
  const dead = useSessionDead();
  const sync = useSyncStatus();
  const port = host.wires.calendar;
  if (port === "none") return undefined;
  const ready = !dead && !sync.bootstrapping && !sync.terminal && !sync.refused && !sync.ownerLost;
  const store = host.engine.store;
  const notifications = host.device.notifications;
  const session = {
    ...host.session,
    liveNoticeScope: notifications === "none" ? undefined : notifications.liveNoticeScope,
  };
  return calendarReadsOf({
    liveScope: () => (ready ? liveCalendarScope(host.engine, session) : null),
    events: () => port.events(),
    calendars: () => store.entries<CalendarRecord | null>("calendar").flatMap(({ entity }) => entity ?? []),
    suggestions: () =>
      store
        .entries<CalendarSuggestionRecord | null>("calendar_suggestion")
        .flatMap(({ entity }) => entity ?? []),
    ownAddresses: () => ownAddresses,
    zone: readerZone,
    zones: readerZones(),
    showTitles,
    acts,
  });
}
