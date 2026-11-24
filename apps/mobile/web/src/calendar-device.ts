import { useRef, useState } from "react";
import { localStorageDoor } from "@ohmail/app-logic/storage/durable";
import { CALENDAR_DEVICE_START, CALENDAR_OPEN_VIEWS, type CalendarDeviceSettings } from "@ohmail/app/calsettings";
import { ownsStorage } from "./owner";

const storage = localStorageDoor("calendar.display");
const keyOf = (scope: string) => `ohmail.calendar.display.${scope}`;
const views = new Set<string>(CALENDAR_OPEN_VIEWS);

function validZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function readCalendarDevice(scope: string | null): CalendarDeviceSettings {
  if (scope === null || !ownsStorage(scope)) return CALENDAR_DEVICE_START;
  try {
    const raw = JSON.parse(storage.get(keyOf(scope)) ?? "{}") as Partial<CalendarDeviceSettings>;
    return {
      opensIn: raw.opensIn && views.has(raw.opensIn) ? raw.opensIn : CALENDAR_DEVICE_START.opensIn,
      weekStart: raw.weekStart === 5 || raw.weekStart === 6 ? raw.weekStart : 0,
      weekends: raw.weekends !== false,
      showDeclined: raw.showDeclined !== false,
      zone: validZone(raw.zone),
      mailOffers: raw.mailOffers !== false,
      mailEvidenceOff: stringsOf(raw.mailEvidenceOff),
      calendarMailboxesOff: stringsOf(raw.calendarMailboxesOff),
    };
  } catch {
    return CALENDAR_DEVICE_START;
  }
}

export function usePhoneCalendarDevice(scope: string | null) {
  const [settings, setSettings] = useState(() => readCalendarDevice(scope));
  const current = useRef(settings);
  return {
    settings,
    change(patch: Partial<CalendarDeviceSettings>) {
      if (scope === null || !ownsStorage(scope)) return false;
      const next = { ...current.current, ...patch };
      if (storage.set(keyOf(scope), JSON.stringify(next)) === "lost") return false;
      current.current = next;
      setSettings(next);
      return true;
    },
  };
}
