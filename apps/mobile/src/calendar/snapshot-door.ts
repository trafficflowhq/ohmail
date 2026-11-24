/**
 * THE NATIVE END OF THE ACT `calendar.snapshot`: what the phone does with the page's record of the coming days. The
 * guard has read the request closed (`shell/bridge-kinds.ts`); this is the last reader before the native module,
 * and it decides whether anything is kept at all:
 *
 *  · the record is read closed again by the contract's own reader, and only that copy goes on;
 *  · only while this door's session is the live one, for its pairing, and only while the pairing's id is minted;
 *  · only a record of this session's own scope: a page that hands over another account's days is refused;
 *  · a build without the calendar's native side keeps nothing.
 *
 * Native is handed the pairing and the copy as one JSON text, reads it closed again, and keeps it only while that
 * pairing is the one signed in on this phone.
 */
import { readCalendarSnapshot, type CalendarSnapshot } from "./record";
import type { CalendarKept } from "../shell/bridge-kinds";
import { isInstance } from "../notices/notices-port";
import { readWidgetTarget } from "./opened";
import type { CalendarNative } from "./calendar-port";

export interface SnapshotDoorDeps {
  /** The calendar's native module, or null where the build has none. */
  readonly native: Pick<CalendarNative, "keep"> & Partial<Pick<CalendarNative, "clear" | "target">> | null;
  /** The pairing this door's session is: the profile's local id. */
  readonly instance: string;
  /** The scope native minted for this session's page; null until it is minted. */
  readonly scope: () => string | null;
  /** Whether that session is still the live one. */
  readonly live: () => boolean;
}

export interface SnapshotDoor {
  /** The record as the page handed it. One that does not read closed is refused and nothing runs. */
  clear(publication: string): Promise<{ readonly calendar: CalendarKept }>;
  target(generation: string): { readonly widget?: NonNullable<ReturnType<typeof readWidgetTarget>> };
  keep(raw: unknown, publication?: string): Promise<{ readonly calendar: CalendarKept } | { readonly refused: "malformed" }>;
}

function titleFree(snapshot: CalendarSnapshot): CalendarSnapshot {
  const label = (value: CalendarSnapshot["alerts"][number]["label"]) =>
    value.as === "title" ? { as: "event" } as const : value;
  return {
    ...snapshot,
    alerts: snapshot.alerts.map((alert) => ({ ...alert, label: label(alert.label) })),
    days: snapshot.days.map((day) => ({
      ...day, events: day.events.map((event) => ({ ...event, label: label(event.label) })),
    })),
  };
}

export function snapshotDoor(deps: SnapshotDoorDeps): SnapshotDoor {
  return {
    async clear(publication) {
      if (!deps.native?.clear) return { calendar: "unsupported" };
      if (!deps.live() || !isInstance(deps.instance)) return { calendar: "denied" };
      return { calendar: await deps.native.clear(deps.instance, publication).catch(() => false) ? "kept" : "denied" };
    },
    target(generation) {
      if (!deps.live()) return {};
      try {
        const widget = readWidgetTarget(deps.native?.target?.(deps.instance, generation));
        return widget === null ? {} : { widget };
      } catch {
        return {};
      }
    },
    async keep(raw, publication) {
      const snapshot = readCalendarSnapshot(raw);
      if (snapshot === null) return { refused: "malformed" };
      const native = deps.native;
      if (native === null) return { calendar: "unsupported" };
      if (!deps.live() || !isInstance(deps.instance) || snapshot.scope !== deps.scope()) return { calendar: "denied" };
      try {
        return { calendar: (await native.keep(deps.instance, JSON.stringify(titleFree(snapshot)), publication ?? undefined)) === true ? "kept" : "denied" };
      } catch {
        // A record that could not be kept takes nothing down.
        return { calendar: "denied" };
      }
    },
  };
}
