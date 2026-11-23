import { createContext, useContext } from "react";

export const CALENDAR_OPEN_VIEWS = ["agenda", "day", "week", "month", "year"] as const;

export interface CalendarDeviceSettings {
  readonly opensIn: (typeof CALENDAR_OPEN_VIEWS)[number];
  readonly weekStart: 0 | 5 | 6;
  readonly weekends: boolean;
  readonly showDeclined: boolean;
  readonly zone: string | null;
  readonly mailOffers: boolean;
  readonly mailEvidenceOff: readonly string[];
  readonly calendarMailboxesOff: readonly string[];
}

export const CALENDAR_DEVICE_START: CalendarDeviceSettings = {
  opensIn: "agenda",
  weekStart: 0,
  weekends: true,
  showDeclined: true,
  zone: null,
  mailOffers: true,
  mailEvidenceOff: [],
  calendarMailboxesOff: [],
};

export const CalendarDeviceContext = createContext<{
  readonly settings: CalendarDeviceSettings;
  change(patch: Partial<CalendarDeviceSettings>): boolean;
} | null>(null);

export const useCalendarDevice = () => useContext(CalendarDeviceContext);
